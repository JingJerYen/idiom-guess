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
  level: LevelSchema.default("hard"),
  /** Hard level: the forbidden words shown for this question; verified against the item's list. */
  forbidden: z.array(z.string().min(1).max(40)).max(5).default([]),
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
  /** Positions the player already has green; the last clue reveals the first position not in this list. */
  knownPositions: z.array(z.number().int().min(0).max(40)).max(40).default([]),
});

export const GiveUpBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
});

export const ReverseGuessBodySchema = z.object({
  idiomId: z.string().min(1).max(64),
  guess: z.string().min(1).max(40),
  attempt: z.number().int().min(1).max(config.maxGuesses),
});
