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
export function mockGuess(descriptions: string[], previousGuesses: string[] = []): GuessResult {
  // Like the real model, never repeat an earlier wrong guess.
  const all = loadIdioms().filter((it) => !previousGuesses.includes(it.idiom));
  const words = keywords(descriptions.join(" "));
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
    return { guess: pick.idiom, reason: "[MOCK] No matching words, so this is a random pick." };
  }
  return { guess: best.idiom, reason: `[MOCK] Matched ${bestScore} key word(s) from the description.` };
}

export function mockFeedback(idiom: Idiom, descriptions: string[]): FeedbackResult {
  const words = descriptions.reduce((n, d) => n + (d.match(/[A-Za-z]+/g)?.length ?? 0), 0);
  return {
    better_phrases: [
      `${idiom.reference_english} — 這是題庫的參考說法，可以直接學起來。`,
      "It's like when... — 用「舉例情境」開頭，比直接下定義更容易讓人懂。",
    ],
    issues: words < 15 ? ["[MOCK] 描述偏短，試著加上一個具體情境或結果。"] : [],
    tip: "[MOCK] 不知道某個字時，先說它「屬於哪一類、用來做什麼、結果如何」，通常對方就猜得到。",
  };
}

export function mockDescribe(idiom: Idiom, attempt: number, previous: string[]): DescribeResult {
  const extras = [
    `Think of a situation where ${idiom.reference_english.charAt(0).toLowerCase()}${idiom.reference_english.slice(1).replace(/\.$/, "")}. People usually say this as a warning or a comment.`,
    `[MOCK hint ${attempt}] It describes a person's behaviour and the lesson we learn from it. Difficulty level ${idiom.difficulty}.`,
  ];
  if (attempt <= 1 || previous.length === 0) return { description: `[MOCK] ${idiom.reference_english}` };
  return { description: extras[Math.min(attempt - 2, extras.length - 1)] };
}
