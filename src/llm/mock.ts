import { config } from "../config.js";
import { loadIdioms, type Idiom } from "../game/idioms.js";
import type { GuessResult, FeedbackResult, DescribeResult } from "./types.js";

const STOP = new Set(
  "a an the and or but of to in on at for with by from is are was were be been being it its this that these those someone something somebody who which what when you your they them their he she his her we our i me my not no do does did done doing have has had very really just only also even still about into over after before than then there here".split(" "),
);

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/u, "");
}

function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (m.length < 3 || STOP.has(m)) continue;
    out.add(stem(m));
  }
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * MOCK guesser: keyword overlap between the player's words and each idiom's reference
 * sentence. It only sees descriptions, like the real model, so wrong guesses are common,
 * which is useful for exercising the retry flow.
 */
/** Crude stand-in for the model's grammar check: capitalised, ends with punctuation, enough words, no doubled spaces. */
export function mockPerfectSentence(text: string): { perfect: boolean; note: string } {
  const t = text.trim();
  if (!/^[A-Z]/.test(t)) return { perfect: false, note: "[MOCK] should start with a capital letter" };
  if (!/[.!?]$/.test(t)) return { perfect: false, note: "[MOCK] should end with . ! or ?" };
  if ((t.match(/[A-Za-z]+/g) ?? []).length < 6) return { perfect: false, note: "[MOCK] too short to be a full sentence" };
  if (/\s{2,}|\bi\b/.test(t)) return { perfect: false, note: "[MOCK] spacing or lowercase 'i'" };
  return { perfect: true, note: "" };
}

export function mockGuess(descriptions: string[], previousGuesses: string[] = []): GuessResult {
  // Like the real model, never repeat an earlier wrong guess.
  const all = loadIdioms().filter((it) => !previousGuesses.includes(it.idiom));
  const words = keywords(descriptions.join(" "));
  const g = mockPerfectSentence(descriptions[descriptions.length - 1] ?? "");
  const grammar = { perfect_sentence: g.perfect, grammar_note: g.note };
  let best: Idiom | null = null;
  let bestScore = 0;
  for (const it of all) {
    const ref = keywords(it.reference_english);
    let score = 0;
    for (const w of words) if (ref.has(w)) score++;
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  if (!best || bestScore === 0) {
    const pick = all[hash(descriptions.join("|")) % all.length];
    return { guess: pick.idiom, reason: "[MOCK] No matching words, so this is a random pick.", ...grammar };
  }
  return { guess: best.idiom, reason: `[MOCK] Matched ${bestScore} key word(s) from the description.`, ...grammar };
}

/** MOCK proofreader: capitalise the first letter, fix lowercase "i", add a final period. */
export function mockFeedback(_idiom: Idiom, descriptions: string[]): FeedbackResult {
  return {
    corrections: descriptions.map((d) => {
      const notes: string[] = [];
      let t = d.trim().replace(/\s+/g, " ");
      if (/\bi\b/.test(t)) { t = t.replace(/\bi\b/g, "I"); notes.push("「i」作為主詞要大寫 I"); }
      if (/^[a-z]/.test(t)) { t = t.charAt(0).toUpperCase() + t.slice(1); notes.push("句首要大寫"); }
      if (!/[.!?]$/.test(t)) { t += "."; notes.push("句尾要加句號"); }
      return { corrected: t, note: notes.length ? `[MOCK] ${notes.join("；")}。` : "" };
    }),
  };
}

export function mockDescribe(idiom: Idiom, attempt: number, previous: string[]): DescribeResult {
  if (attempt >= config.maxGuesses) {
    const digit = idiom.idiom.match(/[一二三四五六七八九十百千萬0-9]/);
    const literal = digit ? `It has the number "${digit[0]}" in it.` : `One of the characters means "${idiom.taboo[0] ?? "something"}".`;
    return { description: `[MOCK last clue] ${literal} ${idiom.reference_english}` };
  }
  const extras = [
    `Think of a situation where ${idiom.reference_english.charAt(0).toLowerCase()}${idiom.reference_english.slice(1).replace(/\.$/, "")}. People usually say this as a warning or a comment.`,
    `[MOCK hint ${attempt}] Think about where you would hear or see this in daily life in Taiwan. Difficulty level ${idiom.difficulty}.`,
  ];
  if (attempt <= 1 || previous.length === 0) return { description: `[MOCK] ${idiom.reference_english}` };
  return { description: extras[Math.min(attempt - 2, extras.length - 1)] };
}
