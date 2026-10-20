import { config, type Effort } from "../config.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { allTags, type Idiom } from "../game/idioms.js";
import { callJson, salvageGuess } from "./callJson.js";
import { mockClueVocab, mockDescribe, mockFeedback, mockGuess } from "./mock.js";
import { CLUE_VOCAB_SYSTEM_PROMPT, buildClueVocabUserMessage } from "../prompts/clueVocab.js";
import { buildGuessSystemPrompt, buildGuessUserMessage, respectsConfirmed, type PreviousGuess } from "../prompts/guess.js";
import { FEEDBACK_SYSTEM_PROMPT, buildFeedbackUserMessage } from "../prompts/feedback.js";
import { DESCRIBE_SYSTEM_PROMPT, buildDescribeUserMessage } from "../prompts/describe.js";
import {
  ClueVocabResultSchema,
  DescribeResultSchema,
  FeedbackResultSchema,
  GuessResultSchema,
  type ClueVocabResult,
  type DescribeResult,
  type FeedbackResult,
  type GuessResult,
} from "./types.js";

export type GuessOutcome = GuessResult & {
  /** True when the model's reply was unusable and a rule-based blind guess was substituted. */
  fallback?: boolean;
};

/** Call settings for one guess: the final guess of a question thinks harder (unless disabled). */
export function guessCallSettings(final: boolean): { thinkingEffort: Effort | null; maxTokens: number } {
  const effort = final ? config.finalGuessEffort : null;
  return { thinkingEffort: effort, maxTokens: effort ? config.maxTokensThinkingGuess : config.maxTokens.guess };
}

/**
 * The guesser never receives the idiom; only the player's descriptions and its own earlier guesses.
 * `final` marks the last allowed guess, which runs with thinking so the AI uses the whole picture.
 */
export async function guessIdiom(descriptions: string[], previousGuesses: PreviousGuess[] = [], opts: { final?: boolean } = {}): Promise<GuessOutcome> {
  const prior = previousGuesses.map((p) => p.guess);
  if (config.mockMode) return mockGuess(descriptions, prior, previousGuesses);
  try {
    const system = buildGuessSystemPrompt(allTags());
    const user = buildGuessUserMessage({ descriptions, previousGuesses });
    const settings = guessCallSettings(Boolean(opts.final));
    const call = (u: string) => callJson({ kind: "guess", system, user: u, ...settings, schema: GuessResultSchema, salvage: salvageGuess });
    let result = await call(user);
    // Low-effort models sometimes drop a confirmed character; ask once more with the violation spelled out.
    if (!respectsConfirmed(result.guess, previousGuesses)) {
      log.warn("guess ignored confirmed characters; retrying", { guess: result.guess });
      const retry = await call(`${user}\n\nYour previous answer "${result.guess}" breaks the HARD CONSTRAINT above. Give a different guess that satisfies it.`);
      if (respectsConfirmed(retry.guess, previousGuesses)) result = retry;
      else log.warn("guess still ignores confirmed characters", { guess: retry.guess });
    }
    return result;
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
  return withFallback("feedback", () => mockFeedback(idiom, descriptions), () => callJson({
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
  }));
}

/** Listening mode word book: study words picked from the clues the AI read. Runs only when the player asks. */
export async function getClueVocab(idiom: Idiom, clues: string[]): Promise<ClueVocabResult> {
  if (config.mockMode) return mockClueVocab(clues);
  return withFallback("clue-vocab", () => mockClueVocab(clues), () => callJson({
    kind: "clue-vocab",
    system: CLUE_VOCAB_SYSTEM_PROMPT,
    user: buildClueVocabUserMessage({ idiom: idiom.idiom, tags: idiom.tags, clues }),
    maxTokens: config.maxTokens.clueVocab,
    schema: ClueVocabResultSchema,
  }));
}

function stripMockTags<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\\?\[MOCK[^\]]*\]\s*/g, "")) as T;
}

/**
 * Run a model call; if its output is unreadable (after retry), substitute rule-based
 * content so the player never sees a formatting error. API/network failures still throw.
 */
async function withFallback<T>(kind: string, fallback: () => T, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AppError && err.code === "MODEL_OUTPUT_INVALID") {
      log.error(`${kind} fell back to mock content`, { details: err.details });
      return stripMockTags(fallback());
    }
    throw err;
  }
}

export interface DescribeOptions {
  /** Literal fact for the last clue, chosen by the route (so it can differ from the revealed tile). */
  literal?: { position: number; category: string; english: string } | null;
  numbers?: string[];
}

export async function describeIdiom(idiom: Idiom, attempt: number, previousClues: string[], opts: DescribeOptions = {}): Promise<DescribeResult> {
  if (config.mockMode) return mockDescribe(idiom, attempt, previousClues, opts.literal ?? null);
  return withFallback("describe", () => mockDescribe(idiom, attempt, previousClues), () => callJson({
    kind: "describe",
    system: DESCRIBE_SYSTEM_PROMPT,
    user: buildDescribeUserMessage({
      idiom: idiom.idiom,
      tags: idiom.tags,
      referenceEnglish: idiom.reference_english,
      forbidden: idiom.taboo,
      attempt,
      isLast: attempt >= config.maxGuesses,
      literal: opts.literal ?? null,
      numbers: opts.numbers ?? [],
      previousClues,
    }),
    maxTokens: config.maxTokens.describe,
    schema: DescribeResultSchema,
  }));
}
