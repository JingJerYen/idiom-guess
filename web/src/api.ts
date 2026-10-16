export type Mode = "forward" | "reverse";

export interface Question {
  id: string;
  idiom?: string;
  difficulty: 1 | 2 | 3;
  tabooWords: string[];
}

export interface RoundResponse {
  ok: true;
  mode: Mode;
  maxGuesses: number;
  mock: boolean;
  questions: Question[];
}

export type Violation =
  | { type: "chinese"; chars: string[] }
  | { type: "pinyin" }
  | { type: "taboo"; words: string[] }
  | { type: "too_short"; words: number; min: number }
  | { type: "too_long"; chars: number; max: number }
  | { type: "empty" };

export type GuessResponse =
  | { ok: true; guess: string; reason: string; correct: boolean; attempt: number; remaining: number }
  | { ok: false; violations: Violation[] };

export interface FeedbackResponse {
  ok: true;
  better_phrases: string[];
  issues: string[];
  tip: string;
  reference_english: string;
}

export interface DescribeResponse { ok: true; description: string; attempt: number }

export interface ReverseGuessResponse {
  ok: true;
  correct: boolean;
  attempt: number;
  remaining: number;
  answer?: string;
  reference_english?: string;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("NETWORK", "連不上伺服器，請檢查網路。", 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: { code: string; message: string } }) | null;
  if (!data) throw new ApiError("BAD_RESPONSE", "伺服器回應無法解析。", res.status);
  if (!res.ok && data.error) throw new ApiError(data.error.code, data.error.message, res.status);
  return data as T;
}

export const api = {
  round: (mode: Mode) => request<RoundResponse>(`/api/round?mode=${mode}`),
  guess: (idiomId: string, descriptions: string[]) =>
    request<GuessResponse>("/api/guess", { method: "POST", body: JSON.stringify({ idiomId, descriptions }) }),
  feedback: (idiomId: string, descriptions: string[], guessedCorrectly: boolean, attempts: number) =>
    request<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ idiomId, descriptions, guessedCorrectly, attempts }),
    }),
  describe: (idiomId: string, attempt: number, previousClues: string[]) =>
    request<DescribeResponse>("/api/describe", { method: "POST", body: JSON.stringify({ idiomId, attempt, previousClues }) }),
  reverseGuess: (idiomId: string, guess: string, attempt: number) =>
    request<ReverseGuessResponse>("/api/reverse-guess", { method: "POST", body: JSON.stringify({ idiomId, guess, attempt }) }),
};
