import { Router, type Request } from "express";
import type { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { getIdiomById, loadIdioms, pickRound, toPublic, type Idiom } from "../game/idioms.js";
import { isCorrectGuess } from "../game/match.js";
import { validateDescription } from "../game/validate.js";
import { describeIdiom, getFeedback, guessIdiom } from "../llm/index.js";
import { lightLimiter, modelLimiter } from "../middleware/rateLimit.js";
import {
  DescribeBodySchema,
  FeedbackBodySchema,
  GuessBodySchema,
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

/** Re-check every description server-side; earlier ones were checked before but never trust the client. */
function checkDescriptions(descriptions: string[], idiom: Idiom) {
  for (const d of descriptions) {
    const v = validateDescription(d, idiom);
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
  const questions = pickRound(loadIdioms()).map((q) => toPublic(q, mode.data));
  res.json({ ok: true, mode: mode.data, maxGuesses: config.maxGuesses, mock: config.mockMode, questions });
});

api.post("/guess", modelLimiter, async (req, res) => {
  const body = parseBody(req, GuessBodySchema);
  const idiom = requireIdiom(body.idiomId);

  const bad = checkDescriptions(body.descriptions, idiom);
  if (bad) {
    // Rule violation: no model call, no attempt consumed.
    res.status(422).json({ ok: false, violations: bad.violations });
    return;
  }

  // The guesser gets descriptions only; the answer never leaves this handler.
  const result = await guessIdiom(body.descriptions);
  const correct = isCorrectGuess(result.guess, idiom);
  const attempt = body.descriptions.length;
  res.json({
    ok: true,
    guess: result.guess,
    reason: result.reason,
    correct,
    attempt,
    remaining: Math.max(0, config.maxGuesses - attempt),
  });
});

api.post("/feedback", modelLimiter, async (req, res) => {
  const body = parseBody(req, FeedbackBodySchema);
  const idiom = requireIdiom(body.idiomId);
  const fb = await getFeedback(idiom, body.descriptions, body.guessedCorrectly, body.attempts);
  res.json({ ok: true, ...fb, reference_english: idiom.reference_english });
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
    attempt: body.attempt,
    remaining: Math.max(0, config.maxGuesses - body.attempt),
    // Reveal the answer only when the question is over.
    ...(correct || exhausted ? { answer: idiom.idiom, reference_english: idiom.reference_english } : {}),
  });
});
