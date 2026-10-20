export type Mode = "forward" | "reverse";
export type Level = "easy" | "hard";

export interface TabooWord { en: string; zh: string }

export interface Question {
  id: string;
  idiom?: string;
  tags: string[];
  length?: number;
  difficulty: 1 | 2 | 3;
  hintWords: TabooWord[];
  forbiddenWords: TabooWord[];
}

export interface RoundResponse {
  ok: true;
  mode: Mode;
  maxGuesses: number;
  mock: boolean;
  /** Server-side audio features (need GAME_OPENAI_KEY); the client falls back to browser APIs when false. */
  features?: { stt: boolean; tts: boolean };
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
  | { ok: true; guess: string; reason: string; correct: boolean; positions: boolean[]; perfectSentence: boolean; grammarNote: string; fallback: boolean; attempt: number; remaining: number }
  | { ok: false; violations: Violation[] };

export interface FeedbackResponse {
  ok: true;
  /** One entry per description the player wrote, same order. */
  corrections: { corrected: string; note: string }[];
  /** Word-book material (added only when the player taps ＋ 詞本). */
  vocab: { word: string; zh: string; example: string }[];
  grammar: { title: string; wrong: string; fixed: string } | null;
  reference_english: string;
}

export interface DescribeResponse {
  ok: true;
  description: string;
  attempt: number;
  /** Present on the last clue: one character of the answer, shown in the slots. */
  reveal: { index: number; char: string } | null;
}

export interface GiveUpResponse { ok: true; answer: string; tags: string[]; reference_english: string }

export interface ReverseGuessResponse {
  ok: true;
  correct: boolean;
  positions: boolean[];
  attempt: number;
  remaining: number;
  answer?: string;
  tags?: string[];
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

/** Upload a recorded clip; returns the transcript. */
export async function transcribeClip(blob: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
  } catch {
    throw new ApiError("NETWORK", "連不上伺服器，請檢查網路。", 0);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; error?: { code: string; message: string } } | null;
  if (!res.ok || !data?.ok) throw new ApiError(data?.error?.code ?? "STT", data?.error?.message ?? "語音辨識失敗", res.status);
  return data.text ?? "";
}

export function ttsUrl(text: string, speed: number): string {
  return `/api/tts?text=${encodeURIComponent(text)}&speed=${speed}`;
}

export const api = {
  round: (mode: Mode, level: Level) => request<RoundResponse>(`/api/round?mode=${mode}&level=${level}`),
  guess: (idiomId: string, level: Level, forbidden: string[], descriptions: string[], previousGuesses: string[]) =>
    request<GuessResponse>("/api/guess", { method: "POST", body: JSON.stringify({ idiomId, level, forbidden, descriptions, previousGuesses }) }),
  feedback: (idiomId: string, descriptions: string[], guessedCorrectly: boolean, attempts: number) =>
    request<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ idiomId, descriptions, guessedCorrectly, attempts }),
    }),
  describe: (idiomId: string, attempt: number, previousClues: string[], knownPositions: number[]) =>
    request<DescribeResponse>("/api/describe", { method: "POST", body: JSON.stringify({ idiomId, attempt, previousClues, knownPositions }) }),
  giveUp: (idiomId: string) => request<GiveUpResponse>("/api/give-up", { method: "POST", body: JSON.stringify({ idiomId }) }),
  reverseGuess: (idiomId: string, guess: string, attempt: number) =>
    request<ReverseGuessResponse>("/api/reverse-guess", { method: "POST", body: JSON.stringify({ idiomId, guess, attempt }) }),
};
