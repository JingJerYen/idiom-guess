/**
 * Personal word book kept in localStorage. Cards are added silently from the feedback of a
 * question; reviewing is a swipe deck where a card is removed once the player recalls it quickly.
 */

export interface WordCard {
  id: string;
  type: "word";
  word: string;
  zh: string;
  example: string;
  source: string;
  createdAt: number;
  /** How many times it was reviewed and kept (not yet recalled fast enough). */
  misses: number;
}

export interface GrammarCard {
  id: string;
  type: "grammar";
  title: string;
  wrong: string;
  fixed: string;
  source: string;
  createdAt: number;
  misses: number;
}

export type Card = WordCard | GrammarCard;

const KEY = "idiom.vocab";

function read(): Card[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Card[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(cards: Card[]) {
  try { localStorage.setItem(KEY, JSON.stringify(cards)); } catch { /* storage unavailable */ }
}

export function listCards(): Card[] {
  return read();
}

export function cardCount(): number {
  return read().length;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface NewWord { word: string; zh: string; example: string }
export interface NewGrammar { title: string; wrong: string; fixed: string }

/** A usable example actually contains the word, so the front of the card can blank it out. */
export function exampleUsable(example: string, word: string): boolean {
  const ex = example.trim();
  return ex.length > 0 && blankWord(ex, word) !== ex;
}

/**
 * Add cards from one question's feedback. Existing words are updated (newer example), not duplicated.
 * Words whose example does not contain the word are skipped: the model occasionally writes an
 * example without the target word, and such a card has nothing to blank out.
 */
export function addFromFeedback(source: string, words: NewWord[], grammar: NewGrammar | null): number {
  const cards = read();
  let added = 0;
  for (const w of words) {
    const word = w.word.trim();
    if (!word) continue;
    const usable = exampleUsable(w.example ?? "", word);
    const existing = cards.find((c): c is WordCard => c.type === "word" && c.word.toLowerCase() === word.toLowerCase());
    if (existing) {
      if (usable) existing.example = w.example.trim();
      if (w.zh) existing.zh = w.zh;
      continue;
    }
    if (!usable) continue;
    cards.push({ id: newId(), type: "word", word, zh: w.zh, example: w.example.trim(), source, createdAt: Date.now(), misses: 0 });
    added++;
  }
  if (grammar && grammar.title.trim() && grammar.wrong.trim() && grammar.fixed.trim()) {
    const dup = cards.some((c) => c.type === "grammar" && c.wrong.trim().toLowerCase() === grammar.wrong.trim().toLowerCase());
    if (!dup) {
      cards.push({ id: newId(), type: "grammar", title: grammar.title, wrong: grammar.wrong, fixed: grammar.fixed, source, createdAt: Date.now(), misses: 0 });
      added++;
    }
  }
  write(cards);
  return added;
}

export function removeCard(id: string) {
  write(read().filter((c) => c.id !== id));
}

/** Keep a card after a miss or a slow recall: bump its counter and move it to the back of the deck. */
export function keepCard(id: string) {
  const cards = read();
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = cards.splice(i, 1);
  c.misses += 1;
  cards.push(c);
  write(cards);
}

/** Blank the target word (any inflection) out of its example: "waits" -> "＿＿＿". */
export function blankWord(example: string, word: string): string {
  const base = word.trim().split(/\s+/)[0]?.replace(/[^A-Za-z']/g, "") ?? "";
  if (!base) return example;
  const stem = base.replace(/(ing|ed|es|s)$/i, "").slice(0, Math.max(3, base.length - 3));
  const re = new RegExp(`\\b${escapeRe(stem)}[a-z']*`, "gi");
  const out = example.replace(re, "＿＿＿");
  return out === example ? example.replace(new RegExp(`\\b${escapeRe(base)}\\b`, "gi"), "＿＿＿") : out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
