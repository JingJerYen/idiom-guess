import { config } from "../config.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { allTags, type Idiom } from "../game/idioms.js";
import { callJson, salvageGuess } from "./callJson.js";
import { mockDescribe, mockFeedback, mockGuess } from "./mock.js";
import { buildGuessSystemPrompt, buildGuessUserMessage, type PreviousGuess } from "../prompts/guess.js";
import { FEEDBACK_SYSTEM_PROMPT, buildFeedbackUserMessage } from "../prompts/feedback.js";
import { DESCRIBE_SYSTEM_PROMPT, buildDescribeUserMessage } from "../prompts/describe.js";
import {
  DescribeResultSchema,
  FeedbackResultSchema,
  GuessResultSchema,
  type DescribeResult,
  type FeedbackResult,
  type GuessResult,
} from "./types.js";

export type GuessOutcome = GuessResult & {
  /** True when the model's reply was unusable and a rule-based blind guess was substituted. */
  fallback?: boolean;
};

/** The guesser never receives the idiom; only the player's descriptions and its own earlier guesses. */
export async function guessIdiom(descriptions: string[], previousGuesses: PreviousGuess[] = []): Promise<GuessOutcome> {
  const prior = previousGuesses.map((p) => p.guess);
  if (config.mockMode) return mockGuess(descriptions, prior);
  try {
    return await callJson({
      kind: "guess",
      // The guesser learns which kinds of terms exist in the bank, never which kind this item is.
      system: buildGuessSystemPrompt(allTags()),
      user: buildGuessUserMessage({ descriptions, previousGuesses }),
      maxTokens: config.maxTokens.guess,
      schema: GuessResultSchema,
      salvage: salvageGuess,
    });
  } catch (err) {
    // Unreadable output (after salvage and one retry): keep the game moving with a blind guess.
    // API/network failures still surface as errors, because then nothing is working.
    if (err instanceof AppError && err.code === "MODEL_OUTPUT_INVALID") {
      log.error("guess fell back to blind mock guess", { details: err.details });
      const blind = mockGuess(descriptions, prior);
      return {
        guess: blind.guess,
        reason: "The AI's reply could not be read, so this is a blind guess.",
        perfect_sentence: false,
        grammar_note: "",
        fallback: true,
      };
    }
    throw err;
  }
}

export async function getFeedback(
  idiom: Idiom,
  descriptions: string[],
  guessedCorrectly: boolean,
  attempts: number,
): Promise<FeedbackResult> {
  if (config.mockMode) return mockFeedback(idiom, descriptions);
  return callJson({
    kind: "feedback",
    system: FEEDBACK_SYSTEM_PROMPT,
    user: buildFeedbackUserMessage({
      idiom: idiom.idiom,
      tags: idiom.tags,
      referenceEnglish: idiom.reference_english,
      descriptions,
      guessedCorrectly,
      attempts,
    }),
    maxTokens: config.maxTokens.feedback,
    schema: FeedbackResultSchema,
  });
}

export async function describeIdiom(idiom: Idiom, attempt: number, previousClues: string[]): Promise<DescribeResult> {
  if (config.mockMode) return mockDescribe(idiom, attempt, previousClues);
  return callJson({
    kind: "describe",
    system: DESCRIBE_SYSTEM_PROMPT,
    user: buildDescribeUserMessage({
      idiom: idiom.idiom,
      tags: idiom.tags,
      referenceEnglish: idiom.reference_english,
      forbidden: idiom.taboo,
      attempt,
      previousClues,
    }),
    maxTokens: config.maxTokens.describe,
    schema: DescribeResultSchema,
  });
}
