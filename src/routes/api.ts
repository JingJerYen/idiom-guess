import express, { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { getIdiomById, loadIdioms, pickRound, toPublic, type Idiom } from "../game/idioms.js";
import { isCorrectGuess, normalizeIdiom, positionMatches } from "../game/match.js";
import { CATEGORY_LABEL, numbersIn, pickLiteralHint } from "../game/literal.js";
import { validateDescription } from "../game/validate.js";
import { describeIdiom, getFeedback, guessIdiom } from "../llm/index.js";
import { sttEnabled, synthesize, transcribe, ttsEnabled } from "../llm/openai.js";
import { lightLimiter, modelLimiter } from "../middleware/rateLimit.js";
import {
  DescribeBodySchema,
  FeedbackBodySchema,
  GiveUpBodySchema,
  GuessBodySchema,
  LevelSchema,
  ModeSchema,
  ReverseGuessBodySchema,
} from "./schemas.js";

export const api = Router();

function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const r = schema.safeParse(req.body);
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

api.get("/health", (_req, res) => {
  res.json({ ok: true, mock: config.mockMode, mockReason: config.mockReason, model: config.model, stt: sttEnabled, tts: ttsEnabled });
});

api.get("/round", lightLimiter, (req, res) => {
  const mode = ModeSchema.safeParse(req.query.mode ?? "forward");
  if (!mode.success) throw new AppError("BAD_REQUEST", "mode 必須是 forward 或 reverse。");
  const level = LevelSchema.safeParse(req.query.level ?? "hard");
  if (!level.success) throw new AppError("BAD_REQUEST", "level 必須是 easy 或 hard。");
  const questions = pickRound(loadIdioms()).map((q) => toPublic(q, mode.data, level.data));
  res.json({ ok: true, mode: mode.data, level: level.data, maxGuesses: config.maxGuesses, mock: config.mockMode, features: { stt: sttEnabled, tts: ttsEnabled }, questions });
});

api.post("/guess", modelLimiter, async (req, res) => {
  const body = parseBody(req, GuessBodySchema);
  const idiom = requireIdiom(body.idiomId);

  const forbidden = body.level === "hard" ? verifiedForbidden(body.forbidden, idiom) : [];
  const bad = checkDescriptions(body.descriptions, idiom, forbidden);
  if (bad) {
    // Rule violation: no model call, no attempt consumed.
    res.status(422).json({ ok: false, violations: bad.violations });
    return;
  }

  // Re-score the AI's earlier guesses here so the hint reflects the real answer, not client data.
  const previousGuesses = body.previousGuesses.map((g) => {
    if (isCorrectGuess(g, idiom)) throw new AppError("BAD_REQUEST", "這題已經結束了。");
    const chars = Array.from(normalizeIdiom(g));
    const hits = positionMatches(g, idiom);
    return { guess: g, confirmed: chars.map((ch, i) => (hits[i] ? ch : null)) };
  });

  // The guesser gets descriptions plus its own earlier guesses; the full answer never leaves this handler.
  const result = await guessIdiom(body.descriptions, previousGuesses);
  const correct = isCorrectGuess(result.guess, idiom);
  const attempt = body.descriptions.length;
  res.json({
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

api.post("/feedback", modelLimiter, async (req, res) => {
  const body = parseBody(req, FeedbackBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const fb = await getFeedback(idiom, body.descriptions, body.guessedCorrectly, body.attempts);
  // Keep one correction per description; fall back to the original text where the model gave none.
  const corrections = body.descriptions.map((d, i) => ({
    corrected: fb.corrections[i]?.corrected.trim() || d,
    note: fb.corrections[i]?.note ?? "",
  }));
  res.json({ ok: true, corrections, vocab: fb.vocab, grammar: fb.grammar, reference_english: idiom.reference_english });
});

// ---- Audio (optional, needs GAME_OPENAI_KEY) ----

/** Whisper speech-to-text. Body is the raw audio blob the browser recorded. */
api.post("/transcribe", modelLimiter, express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "8mb" }), async (req, res) => {
  if (!sttEnabled) throw new AppError("UPSTREAM_ERROR", "語音辨識未啟用。", 503);
  const body = req.body as Buffer | undefined;
  if (!body || !Buffer.isBuffer(body) || body.length < 1000) throw new AppError("BAD_REQUEST", "沒有收到音訊。");
  const text = await transcribe(body, (req.headers["content-type"] ?? "audio/webm").split(";")[0]);
  res.json({ ok: true, text });
});

const TtsQuery = z.object({
  text: z.string().trim().min(1).max(400),
  speed: z.coerce.number().min(0.5).max(1.5).default(1),
});

/** Text-to-speech for listening clues; returns mp3. */
api.get("/tts", modelLimiter, async (req, res) => {
  if (!ttsEnabled) throw new AppError("UPSTREAM_ERROR", "語音合成未啟用。", 503);
  const q = TtsQuery.safeParse(req.query);
  if (!q.success) throw new AppError("BAD_REQUEST", "text 或 speed 不正確。");
  const audio = await synthesize(q.data.text, q.data.speed);
  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("cache-control", "private, max-age=3600");
  res.send(audio);
});

/** Player gives up: zero points, reveal the answer. */
api.post("/give-up", lightLimiter, (req, res) => {
  const body = parseBody(req, GiveUpBodySchema);
  const idiom = requireIdiom(body.idiomId);
  res.json({ ok: true, answer: idiom.idiom, tags: idiom.tags, reference_english: idiom.reference_english });
});

// ---- Reverse mode: AI describes, player guesses the idiom ----

api.post("/describe", modelLimiter, async (req, res) => {
  const body = parseBody(req, DescribeBodySchema);
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
  res.json({ ok: true, description: out.description, attempt: body.attempt, reveal });
});

api.post("/reverse-guess", modelLimiter, (req, res) => {
  const body = parseBody(req, ReverseGuessBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const correct = isCorrectGuess(body.guess, idiom);
  const exhausted = body.attempt >= config.maxGuesses;
  res.json({
    ok: true,
    correct,
    positions: positionMatches(body.guess, idiom),
    attempt: body.attempt,
    remaining: Math.max(0, config.maxGuesses - body.attempt),
    // Reveal the answer only when the question is over.
    ...(correct || exhausted ? { answer: idiom.idiom, tags: idiom.tags, reference_english: idiom.reference_english } : {}),
  });
});
