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

/**
 * Wordle-style per-character result: true when the guess character is the same
 * character at the same position in the answer (or in the best-matching alias).
 * Only "right character, right position" is reported; nothing else about the
 * answer leaks. Returns one boolean per character of the normalized guess.
 */
export function positionMatches(guess: string, idiom: Idiom): boolean[] {
  const g = Array.from(normalizeIdiom(guess));
  if (!g.length) return [];
  const candidates = [idiom.idiom, ...idiom.aliases].map((c) => Array.from(normalizeIdiom(c)));
  let best: boolean[] = g.map(() => false);
  let bestCount = -1;
  for (const c of candidates) {
    const m = g.map((ch, i) => i < c.length && c[i] === ch);
    const count = m.filter(Boolean).length;
    if (count > bestCount) {
      best = m;
      bestCount = count;
    }
  }
  return best;
}
