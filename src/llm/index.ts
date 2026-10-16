import { config } from "../config.js";
import type { Idiom } from "../game/idioms.js";
import { callJson } from "./callJson.js";
import { mockDescribe, mockFeedback, mockGuess } from "./mock.js";
import { GUESS_SYSTEM_PROMPT, buildGuessUserMessage, type PreviousGuess } from "../prompts/guess.js";
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

/** The guesser never receives the idiom; only the player's descriptions and its own earlier guesses. */
export async function guessIdiom(descriptions: string[], previousGuesses: PreviousGuess[] = []): Promise<GuessResult> {
  if (config.mockMode) return mockGuess(descriptions, previousGuesses.map((p) => p.guess));
  return callJson({
    kind: "guess",
    system: GUESS_SYSTEM_PROMPT,
    user: buildGuessUserMessage({ descriptions, previousGuesses }),
    maxTokens: config.maxTokens.guess,
    schema: GuessResultSchema,
  });
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
      referenceEnglish: idiom.reference_english,
      forbidden: idiom.taboo,
      attempt,
      previousClues,
    }),
    maxTokens: config.maxTokens.describe,
    schema: DescribeResultSchema,
  });
}
