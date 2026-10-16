import { z } from "zod";
import { config } from "../config.js";
import { MAX_CHARS } from "../game/validate.js";

export const ModeSchema = z.enum(["forward", "reverse"]);

/** Up to maxGuesses descriptions; each bounded so the body stays small. */
export const DescriptionsSchema = z
  .array(z.string().max(MAX_CHARS * 2))
  .min(1)
  .max(config.maxGuesses);

export const LevelSchema = z.enum(["easy", "hard"]);

export const GuessBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
  /** Kept for logging/compat; the level no longer changes server-side checks. */
  level: LevelSchema.default("hard"),
  descriptions: DescriptionsSchema,
  /** The AI's earlier guesses for this question (client-held state, re-scored server-side). */
  previousGuesses: z.array(z.string().max(20)).max(Math.max(0, config.maxGuesses - 1)).default([]),
});

export const FeedbackBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
  descriptions: DescriptionsSchema,
  guessedCorrectly: z.boolean(),
  attempts: z.number().int().min(1).max(config.maxGuesses),
});

export const DescribeBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
  attempt: z.number().int().min(1).max(config.maxGuesses),
  previousClues: z.array(z.string().max(500)).max(config.maxGuesses).default([]),
});

export const GiveUpBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
});

export const ReverseGuessBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
  guess: z.string().min(1).max(40),
  attempt: z.number().int().min(1).max(config.maxGuesses),
});
