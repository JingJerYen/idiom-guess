import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config, type Env } from "../config.js";
import { AppError } from "../errors.js";
import { getIdiomById, loadIdioms, pickRound, toPublic, type Idiom } from "../game/idioms.js";
import { isCorrectGuess, normalizeIdiom, positionMatches } from "../game/match.js";
import { CATEGORY_LABEL, numbersIn, pickLiteralHint } from "../game/literal.js";
import { validateDescription } from "../game/validate.js";
import { anchorToClues } from "../game/clueVocab.js";
import { defineWord, describeIdiom, getClueVocab, getFeedback, guessIdiom } from "../llm/index.js";
import { sttEnabled, synthesize, transcribe, ttsEnabled } from "../llm/openai.js";
import { lightLimiter, modelLimiter } from "../middleware/rateLimit.js";
import {
  ClueVocabBodySchema,
  DefineBodySchema,
  DescribeBodySchema,
  FeedbackBodySchema,
  GiveUpBodySchema,
  GuessBodySchema,
  LevelSchema,
  ModeSchema,
  ReverseGuessBodySchema,
} from "./schemas.js";

export const api = new Hono<{ Bindings: Env }>();

/** JSON bodies are tiny; the audio upload route sets its own, larger cap. */
const jsonLimit = bodyLimit({ maxSize: 10 * 1024, onError: () => { throw new AppError("BAD_REQUEST", "請求內容太大。", 413); } });
const audioLimit = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: () => { throw new AppError("BAD_REQUEST", "請求內容太大。", 413); } });

async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "JSON 格式錯誤。");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError("BAD_REQUEST", "請求格式不正確。", 400, r.error.issues);
  }
  return r.data;
}

function requireIdiom(id: string): Idiom {
  const idiom = getIdiomById(id);
  if (!idiom) throw new AppError("NOT_FOUND", "找不到這個題目。", 404);
  return idiom;
}

/** The client echoes the forbidden words it was shown; accept only words from the item's own list. */
function verifiedForbidden(words: string[], idiom: Idiom): string[] {
  const allowed = new Map(idiom.taboo.map((w) => [w.toLowerCase(), w]));
  const out: string[] = [];
  for (const w of words) {
    const hit = allowed.get(w.trim().toLowerCase());
    if (!hit) throw new AppError("BAD_REQUEST", "禁用詞與題目不符。");
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Re-check every description server-side; earlier ones were checked before but never trust the client. */
function checkDescriptions(descriptions: string[], idiom: Idiom, forbidden: string[]) {
  for (const d of descriptions) {
    const v = validateDescription(d, idiom, { forbidden });
    if (!v.ok) return v;
  }
  return null;
}

api.get("/health", (c) =>
  c.json({ ok: true, mock: config.mockMode, mockReason: config.mockReason, model: config.model, stt: sttEnabled(), tts: ttsEnabled() }),
);

api.get("/round", lightLimiter, (c) => {
  const mode = ModeSchema.safeParse(c.req.query("mode") ?? "forward");
  if (!mode.success) throw new AppError("BAD_REQUEST", "mode 必須是 forward 或 reverse。");
  const level = LevelSchema.safeParse(c.req.query("level") ?? "hard");
  if (!level.success) throw new AppError("BAD_REQUEST", "level 必須是 easy 或 hard。");
  const questions = pickRound(loadIdioms()).map((q) => toPublic(q, mode.data, level.data));
  return c.json({ ok: true, mode: mode.data, level: level.data, maxGuesses: config.maxGuesses, mock: config.mockMode, features: { stt: sttEnabled(), tts: ttsEnabled() }, questions });
});

api.post("/guess", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, GuessBodySchema);
  const idiom = requireIdiom(body.idiomId);

  const forbidden = body.level === "hard" ? verifiedForbidden(body.forbidden, idiom) : [];
  const bad = checkDescriptions(body.descriptions, idiom, forbidden);
  if (bad) {
    // Rule violation: no model call, no attempt consumed.
    return c.json({ ok: false, violations: bad.violations }, 422);
  }

  // Re-score the AI's earlier guesses here so the hint reflects the real answer, not client data.
  const previousGuesses = body.previousGuesses.map((g) => {
    if (isCorrectGuess(g, idiom)) throw new AppError("BAD_REQUEST", "這題已經結束了。");
    const chars = Array.from(normalizeIdiom(g));
    const hits = positionMatches(g, idiom);
    return { guess: g, confirmed: chars.map((ch, i) => (hits[i] ? ch : null)) };
  });

  // The guesser gets descriptions plus its own earlier guesses; the full answer never leaves this handler.
  const attempt = body.descriptions.length;
  const result = await guessIdiom(body.descriptions, previousGuesses, { final: attempt >= config.maxGuesses });
  const correct = isCorrectGuess(result.guess, idiom);
  return c.json({
    ok: true,
    guess: result.guess,
    reason: result.reason,
    correct,
    positions: positionMatches(result.guess, idiom),
    perfectSentence: result.perfect_sentence,
    grammarNote: result.grammar_note,
    fallback: result.fallback === true,
    attempt,
    remaining: Math.max(0, config.maxGuesses - attempt),
  });
});

api.post("/feedback", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, FeedbackBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const fb = await getFeedback(idiom, body.descriptions, body.guessedCorrectly, body.attempts);
  // Keep one correction per description; fall back to the original text where the model gave none.
  const corrections = body.descriptions.map((d, i) => ({
    corrected: fb.corrections[i]?.corrected.trim() || d,
    note: fb.corrections[i]?.note ?? "",
  }));
  return c.json({ ok: true, corrections, vocab: fb.vocab, grammar: fb.grammar, reference_english: idiom.reference_english });
});

/** Tap-to-look-up: gloss for one word (or the expression it belongs to) in a sentence shown on the result card. */
api.post("/define", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, DefineBodySchema);
  if (!new RegExp(`\\b${body.word}\\b`, "i").test(body.sentence)) throw new AppError("BAD_REQUEST", "這個字不在句子裡。");
  const r = await defineWord(body.sentence, body.word);
  // The expression must occur in the sentence; otherwise fall back to the tapped word itself.
  const [anchored] = anchorToClues([{ word: r.word, example: "" }], [body.sentence]);
  return c.json({ ok: true, word: anchored ? r.word : body.word.toLowerCase(), zh: r.zh, example: body.sentence });
});

/** Listening mode word book: study words from this question's clues, on demand. */
api.post("/clue-vocab", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, ClueVocabBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const result = await getClueVocab(idiom, body.clues);
  return c.json({ ok: true, vocab: anchorToClues(result.vocab, body.clues) });
});

// ---- Audio (optional, needs GAME_OPENAI_KEY) ----

/** Whisper speech-to-text. Body is the raw audio blob the browser recorded. */
api.post("/transcribe", modelLimiter, audioLimit, async (c) => {
  if (!sttEnabled()) throw new AppError("UPSTREAM_ERROR", "語音辨識未啟用。", 503);
  const mime = (c.req.header("content-type") ?? "audio/webm").split(";")[0].trim().toLowerCase();
  if (!/^(audio\/|video\/webm|application\/octet-stream)/.test(mime)) throw new AppError("BAD_REQUEST", "沒有收到音訊。");
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength < 1000) throw new AppError("BAD_REQUEST", "沒有收到音訊。");
  const text = await transcribe(body, mime);
  return c.json({ ok: true, text });
});

const TtsQuery = z.object({
  text: z.string().trim().min(1).max(400),
  speed: z.coerce.number().min(0.5).max(1.5).default(1),
});

/** Text-to-speech for listening clues; returns mp3. */
api.get("/tts", modelLimiter, async (c) => {
  if (!ttsEnabled()) throw new AppError("UPSTREAM_ERROR", "語音合成未啟用。", 503);
  const q = TtsQuery.safeParse(c.req.query());
  if (!q.success) throw new AppError("BAD_REQUEST", "text 或 speed 不正確。");
  const audio = await synthesize(q.data.text, q.data.speed);
  return c.body(audio as unknown as ArrayBuffer, 200, { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" });
});

/** Player gives up: zero points, reveal the answer. */
api.post("/give-up", lightLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, GiveUpBodySchema);
  const idiom = requireIdiom(body.idiomId);
  return c.json({ ok: true, answer: idiom.idiom, tags: idiom.tags, reference_english: idiom.reference_english });
});

// ---- Reverse mode: AI describes, player guesses the idiom ----

api.post("/describe", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, DescribeBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const last = body.attempt >= config.maxGuesses;
  // Last clue: reveal one character (the first the player does not have yet) AND give the model a
  // literal fact about a different character when possible, so the player gets two distinct hints.
  let reveal: { index: number; char: string } | null = null;
  let literal: { position: number; category: string; english: string } | null = null;
  const term = normalizeIdiom(idiom.idiom);
  if (last) {
    const chars = Array.from(term);
    const idx = chars.findIndex((_, i) => !body.knownPositions.includes(i));
    if (idx >= 0) reveal = { index: idx, char: chars[idx] };
    // Character glosses are literal in idioms (兔 = rabbit) but misleading in compounds
    // (節目's 目 is not an eye), so only idioms get a literal fact.
    const hint = idiom.tags.includes("成語") ? pickLiteralHint(term, [...body.knownPositions, ...(reveal ? [reveal.index] : [])]) : null;
    if (hint) literal = { position: hint.index, category: CATEGORY_LABEL[hint.category], english: hint.english };
  }
  const out = await describeIdiom(idiom, body.attempt, body.previousClues, last ? { literal, numbers: numbersIn(term) } : {});
  return c.json({ ok: true, description: out.description, attempt: body.attempt, reveal });
});

api.post("/reverse-guess", modelLimiter, jsonLimit, async (c) => {
  const body = await parseBody(c, ReverseGuessBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const correct = isCorrectGuess(body.guess, idiom);
  const exhausted = body.attempt >= config.maxGuesses;
  return c.json({
    ok: true,
    correct,
    positions: positionMatches(body.guess, idiom),
    attempt: body.attempt,
    remaining: Math.max(0, config.maxGuesses - body.attempt),
    // Reveal the answer only when the question is over.
    ...(correct || exhausted ? { answer: idiom.idiom, tags: idiom.tags, reference_english: idiom.reference_english } : {}),
  });
});
