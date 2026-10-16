import * as OpenCC from "opencc-js";
import type { Idiom } from "./idioms.js";

const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

/** Normalize a guess: drop whitespace/punctuation, convert simplified to traditional. */
export function normalizeIdiom(text: string): string {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return toTraditional(stripped);
}

export function isCorrectGuess(guess: string, idiom: Idiom): boolean {
  const g = normalizeIdiom(guess);
  if (!g) return false;
  const candidates = [idiom.idiom, ...idiom.aliases].map(normalizeIdiom);
  return candidates.includes(g);
}
