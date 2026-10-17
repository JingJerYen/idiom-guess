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
 * Regular English inflections of a base word, so the bank only needs to list
 * base forms (plus irregulars such as feet, lost, shot):
 *   snake -> snakes; draw -> drawing, drawed; carve -> carving, carved;
 *   worry -> worries, worried, worrying; dig -> digging, digged; bus -> buses.
 */
export function inflections(base: string): string[] {
  const w = base.trim().toLowerCase();
  if (!w) return [];
  const out = new Set<string>([w, `${w}s`, `${w}es`, `${w}ed`, `${w}d`, `${w}ing`]);
  if (/e$/.test(w)) out.add(`${w.slice(0, -1)}ing`);
  if (/[^aeiou]y$/.test(w)) {
    out.add(`${w.slice(0, -1)}ies`);
    out.add(`${w.slice(0, -1)}ied`);
  }
  if (/[aeiou][bdgklmnprt]$/.test(w) && !/[aeiou]{2}[bdgklmnprt]$/.test(w)) {
    const c = w[w.length - 1];
    out.add(`${w}${c}ing`);
    out.add(`${w}${c}ed`);
  }
  return Array.from(out);
}

/**
 * Taboo words match as whole words, case-insensitively, in any regular
 * inflection (see inflections()). Multi-word entries ("old man") match as phrases.
 */
export function findTabooWords(text: string, taboo: string[]): string[] {
  const hits: string[] = [];
  const lower = text.toLowerCase();
  for (const word of taboo) {
    const forms = inflections(word).map((f) => escapeRe(f).replace(/\s+/g, "\\s+"));
    if (!forms.length) continue;
    const re = new RegExp(`(?<![a-z0-9])(?:${forms.join("|")})(?![a-z0-9])`, "i");
    if (re.test(lower)) hits.push(word);
  }
  return hits;
}

export interface ValidateOptions {
  /** Hard level: the words drawn for this question that must not appear (subset of idiom.taboo). */
  forbidden?: string[];
}

/**
 * Rule check for a description: Chinese characters, the full pinyin, the length limits, and
 * (hard level only) the handful of forbidden words drawn for this question. Easy mode shows the
 * whole word list as hints and forbids none of them.
 */
export function validateDescription(text: string, idiom: Idiom, opts: ValidateOptions = {}): ValidationResult {
  const violations: Violation[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, violations: [{ type: "empty" }] };

  if (trimmed.length > MAX_CHARS) {
    violations.push({ type: "too_long", chars: trimmed.length, max: MAX_CHARS });
  }
  const chinese = findChineseChars(trimmed);
  if (chinese.length) violations.push({ type: "chinese", chars: chinese });

  if (containsPinyin(trimmed, idiom.pinyin)) violations.push({ type: "pinyin" });


  if (opts.forbidden?.length) {
    const hits = findTabooWords(trimmed, opts.forbidden);
    if (hits.length) violations.push({ type: "taboo", words: hits });
  }

  const words = countEnglishWords(trimmed);
  if (words < MIN_WORDS) violations.push({ type: "too_short", words, min: MIN_WORDS });

  return { ok: violations.length === 0, violations };
}
