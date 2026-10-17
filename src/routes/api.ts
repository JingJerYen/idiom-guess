import { Router, type Request } from "express";
import type { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { getIdiomById, loadIdioms, pickRound, toPublic, type Idiom } from "../game/idioms.js";
import { isCorrectGuess, normalizeIdiom, positionMatches } from "../game/match.js";
import { validateDescription } from "../game/validate.js";
import { describeIdiom, getFeedback, guessIdiom } from "../llm/index.js";
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
  res.json({ ok: true, mock: config.mockMode, mockReason: config.mockReason, model: config.model });
});

api.get("/round", lightLimiter, (req, res) => {
  const mode = ModeSchema.safeParse(req.query.mode ?? "forward");
  if (!mode.success) throw new AppError("BAD_REQUEST", "mode 必須是 forward 或 reverse。");
  const level = LevelSchema.safeParse(req.query.level ?? "hard");
  if (!level.success) throw new AppError("BAD_REQUEST", "level 必須是 easy 或 hard。");
  const questions = pickRound(loadIdioms()).map((q) => toPublic(q, mode.data, level.data));
  res.json({ ok: true, mode: mode.data, level: level.data, maxGuesses: config.maxGuesses, mock: config.mockMode, questions });
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
  res.json({ ok: true, corrections, reference_english: idiom.reference_english });
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
  const out = await describeIdiom(idiom, body.attempt, body.previousClues);
  res.json({ ok: true, description: out.description, attempt: body.attempt });
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
