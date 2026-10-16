import type { Idiom } from "./idioms.js";

export const MIN_WORDS = 5;
export const MAX_CHARS = 300;

export type Violation =
  | { type: "chinese"; chars: string[] }
  | { type: "pinyin" }
  | { type: "taboo"; words: string[] }
  | { type: "too_short"; words: number; min: number }
  | { type: "too_long"; chars: number; max: number }
  | { type: "empty" };

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

const HAN_RE = /\p{Script=Han}/gu;
const ENGLISH_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

export function countEnglishWords(text: string): number {
  return (text.match(ENGLISH_WORD_RE) ?? []).length;
}

export function findChineseChars(text: string): string[] {
  return Array.from(new Set(text.match(HAN_RE) ?? []));
}

/** Strip tone marks / digits and lowercase, so "huà shé" and "hua2 she2" both become "hua she". */
export function normalizePinyin(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ü/g, "v")
    .toLowerCase()
    .replace(/[0-5]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Only the *whole* pinyin of the idiom is forbidden (with or without spaces),
 * never individual syllables, because syllables like "she" or "he" are English words.
 */
export function containsPinyin(text: string, pinyin: string): boolean {
  const target = normalizePinyin(pinyin);
  if (!target) return false;
  const hay = normalizePinyin(text);
  const hayCompact = hay.replace(/[^a-z]/g, "");
  const spaced = target;
  const compact = target.replace(/\s+/g, "");
  if (new RegExp(`(?<![a-z])${escapeRe(spaced)}(?![a-z])`).test(hay)) return true;
  return hayCompact.includes(compact) && compact.length >= 6;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Taboo words match as whole words, case-insensitively, allowing simple
 * inflections (s, es, ed, ing). Multi-word entries ("old man") match as phrases.
 */
export function findTabooWords(text: string, taboo: string[]): string[] {
  const hits: string[] = [];
  const lower = text.toLowerCase();
  for (const word of taboo) {
    const w = word.trim().toLowerCase();
    if (!w) continue;
    const base = escapeRe(w).replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?<![a-z])${base}(?:s|es|ed|ing)?(?![a-z])`, "i");
    if (re.test(lower)) hits.push(word);
  }
  return hits;
}

export function validateDescription(text: string, idiom: Idiom): ValidationResult {
  const violations: Violation[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, violations: [{ type: "empty" }] };

  if (trimmed.length > MAX_CHARS) {
    violations.push({ type: "too_long", chars: trimmed.length, max: MAX_CHARS });
  }
  const chinese = findChineseChars(trimmed);
  if (chinese.length) violations.push({ type: "chinese", chars: chinese });

  if (containsPinyin(trimmed, idiom.pinyin)) violations.push({ type: "pinyin" });

  const taboo = findTabooWords(trimmed, idiom.taboo);
  if (taboo.length) violations.push({ type: "taboo", words: taboo });

  const words = countEnglishWords(trimmed);
  if (words < MIN_WORDS) violations.push({ type: "too_short", words, min: MIN_WORDS });

  return { ok: violations.length === 0, violations };
}
