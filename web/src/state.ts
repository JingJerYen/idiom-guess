import type { FeedbackResponse, Mode, Question } from "./api.js";

export interface Turn {
  /** Forward: the player's description. Reverse: the player's idiom guess. */
  you: string;
  /** Forward: AI guess. Reverse: unused. */
  guess?: string;
  reason?: string;
  correct: boolean;
}

export interface QuestionState {
  q: Question;
  turns: Turn[];
  /** Reverse mode: clues shown so far. */
  clues: string[];
  done: boolean;
  solved: boolean;
  feedback?: FeedbackResponse | null;
  feedbackError?: string;
  /** Reverse mode: revealed when the question ends. */
  answer?: string;
  referenceEnglish?: string;
}

export interface Game {
  mode: Mode;
  maxGuesses: number;
  mock: boolean;
  questions: QuestionState[];
  index: number;
}

export type Screen =
  | { name: "start" }
  | { name: "loading"; text: string }
  | { name: "play"; game: Game }
  | { name: "summary"; game: Game };

export const MIN_WORDS = 5;
export const MAX_CHARS = 300;

export function countWords(text: string): number {
  return (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;
}
