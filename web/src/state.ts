import type { FeedbackResponse, Level, Mode, Question } from "./api.js";

export interface Turn {
  /** Forward: the player's description. Reverse: the player's idiom guess. */
  you: string;
  /** Forward: AI guess. Reverse: unused. */
  guess?: string;
  reason?: string;
  correct: boolean;
  /** Per-character result for the guess shown in this turn (true = right character, right position). */
  positions?: boolean[];
  /** Forward mode: the model judged this description a complete, error-free sentence. */
  perfect?: boolean;
  grammarNote?: string;
  /** The AI reply was unreadable; this guess is a rule-based stand-in. */
  fallback?: boolean;
  /** Object URL of the player's own recording for this description, when they used the mic. */
  audioUrl?: string;
}

export interface QuestionState {
  q: Question;
  turns: Turn[];
  /** Reverse mode: clues shown so far. */
  clues: string[];
  /** Reverse mode: characters revealed by the last clue, by position. */
  revealed?: Record<number, string>;
  /** Reverse mode: object URLs of server-synthesised clue audio, by clue index (fetched once, replayed locally). */
  clueAudio?: Record<number, string>;
  /** Reverse mode: index of the clue whose text is currently revealed, if any. */
  shownClue?: number;
  /** Forward mode: index of the AI turn whose reason/description text is expanded, if any. */
  shownTurn?: number;
  /** Result card: whether the feedback / transcript section is expanded. */
  showDetails?: boolean;
  /** Forward mode: the feedback's study material was saved to the word book. */
  addedToBook?: boolean;
  /** Word cards currently flipped to Chinese (by index). */
  flipped?: Set<number>;
  /** Forward mode: sentence-starter panel open. */
  showStarters?: boolean;
  done: boolean;
  solved: boolean;
  gaveUp: boolean;
  /** Points earned: SCORES[attempt - 1] when solved, else 0, plus the sentence bonus. */
  score: number;
  /** +5 awarded when the description that solved the question was a perfect sentence. */
  bonus: number;
  feedback?: FeedbackResponse | null;
  feedbackError?: string;
  /** Reverse mode: revealed when the question ends. */
  answer?: string;
  answerTags?: string[];
  referenceEnglish?: string;
}

export interface Game {
  mode: Mode;
  /** easy: word cards may be used in the description; hard: they are forbidden. */
  level: Level;
  /** Server-side audio features available this round. */
  features: { stt: boolean; tts: boolean };
  maxGuesses: number;
  mock: boolean;
  questions: QuestionState[];
  index: number;
}

export type Screen =
  | { name: "start" }
  | { name: "loading"; text: string }
  | { name: "play"; game: Game }
  | { name: "summary"; game: Game; record: RecordResult }
  | { name: "vocab" };

/** Outcome of comparing a finished round with the stored best score for its mode + level. */
export interface RecordResult {
  /** Best before this round, or null when this was the first round of that kind. */
  previous: number | null;
  isNew: boolean;
}

const BEST_KEY = "idiom.best";

function bestKey(mode: Mode, level: Level): string {
  return `${mode}:${level}`;
}

/** Best score per mode + level, kept in localStorage (per browser; never sent to the server). */
export function getBest(mode: Mode, level: Level): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Record<string, number>;
    const v = all[bestKey(mode, level)];
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Record a finished round; returns whether it beat the stored best. */
export function recordScore(mode: Mode, level: Level, score: number): RecordResult {
  const previous = getBest(mode, level);
  const isNew = previous === null || score > previous;
  if (isNew) {
    try {
      const all = JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Record<string, number>;
      all[bestKey(mode, level)] = score;
      localStorage.setItem(BEST_KEY, JSON.stringify(all));
    } catch { /* storage unavailable: still report the result */ }
  }
  return { previous, isNew };
}

/** Points by the attempt on which the answer was found; 0 after that or on give-up. */
export const SCORES: Record<Level, readonly number[]> = { hard: [5, 3, 1], easy: [3, 2, 1] };
export const MAX_ATTEMPTS = 3;
/** Bonus for solving with a complete, error-free sentence (both levels). */
export const SENTENCE_BONUS = 5;

export function maxScore(level: Level): number {
  return SCORES[level][0];
}

export function scoreFor(level: Level, solved: boolean, attempts: number): number {
  return solved ? (SCORES[level][attempts - 1] ?? 0) : 0;
}

export const MIN_WORDS = 5;
export const MAX_CHARS = 300;

export function countWords(text: string): number {
  return (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;
}
