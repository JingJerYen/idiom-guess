import { z } from "zod";
// The bank ships inside the bundle (works on Node and on Workers, which have no filesystem).
import idiomsJson from "../../data/idioms.json" with { type: "json" };
import glossaryJson from "../../data/glossary.json" with { type: "json" };
import { normalizeIdiom } from "./match.js";

const IdiomSchema = z.object({
  id: z.string().min(1),
  idiom: z.string().min(2),
  aliases: z.array(z.string()).default([]),
  /** Kind of answer, e.g. 成語 / 日常用語 / 店家名 / 地標. Free-form, extensible. */
  tags: z.array(z.string().min(1)).min(1),
  pinyin: z.string().min(1),
  taboo: z.array(z.string()).default([]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reference_english: z.string().min(1),
});

export type Idiom = z.infer<typeof IdiomSchema>;

/** What the browser is allowed to see for a question (never taboo-free data like pinyin or the reference). */
export interface PublicQuestion {
  id: string;
  /** Present in forward mode only. In reverse mode the player must guess it. */
  idiom?: string;
  /** The item's kind(s). Shown in both modes so the player knows what sort of term to guess. */
  tags: string[];
  /** Number of characters in the answer (reverse mode only), so the UI can draw empty tiles. */
  length?: number;
  difficulty: 1 | 2 | 3;
  /** Hint word cards (direct translations). Sent only for forward mode at the easy level. */
  hintWords: TabooWord[];
  /** Hard level: FORBIDDEN_COUNT words picked at random from the item's list; the server enforces them. */
  forbiddenWords: TabooWord[];
}

export type GameMode = "forward" | "reverse";
export type GameLevel = "easy" | "hard";

let glossaryCache: Record<string, string> | null = null;

/** English taboo word -> Traditional Chinese gloss, shown when the player flips a word card. */
export function loadGlossary(): Record<string, string> {
  glossaryCache ??= z.record(z.string(), z.string().min(1)).parse(glossaryJson);
  return glossaryCache;
}

export interface TabooWord {
  en: string;
  zh: string;
}

let cache: Idiom[] | null = null;

export function loadIdioms(): Idiom[] {
  if (cache) return cache;
  const list = z.array(IdiomSchema).min(1).parse(idiomsJson);
  const ids = new Set<string>();
  for (const it of list) {
    if (ids.has(it.id)) throw new Error(`Duplicate idiom id: ${it.id}`);
    ids.add(it.id);
  }
  cache = list;
  return list;
}

export function getIdiomById(id: string): Idiom | undefined {
  return loadIdioms().find((i) => i.id === id);
}

/** Every distinct tag in the bank, sorted. This whole list (never the current item's tags) goes to the guesser. */
export function allTags(all: Idiom[] = loadIdioms()): string[] {
  return Array.from(new Set(all.flatMap((i) => i.tags))).sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

export const ROUND_SIZE = 10;

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick a round of questions ordered from easy to hard.
 * Target split for 10 questions: 4 easy, 3 medium, 3 hard; tiers that run short
 * are topped up from the remaining pool.
 */
export function pickRound(
  all: Idiom[] = loadIdioms(),
  size: number = ROUND_SIZE,
  rng: () => number = Math.random,
): Idiom[] {
  const byTier: Record<1 | 2 | 3, Idiom[]> = { 1: [], 2: [], 3: [] };
  for (const it of shuffle(all, rng)) byTier[it.difficulty].push(it);

  const quota: Record<1 | 2 | 3, number> = {
    1: Math.round(size * 0.4),
    2: Math.round(size * 0.3),
    3: size - Math.round(size * 0.4) - Math.round(size * 0.3),
  };

  const chosen: Idiom[] = [];
  const leftovers: Idiom[] = [];
  for (const tier of [1, 2, 3] as const) {
    chosen.push(...byTier[tier].slice(0, quota[tier]));
    leftovers.push(...byTier[tier].slice(quota[tier]));
  }
  for (const extra of shuffle(leftovers, rng)) {
    if (chosen.length >= size) break;
    chosen.push(extra);
  }
  return chosen.sort((a, b) => a.difficulty - b.difficulty).slice(0, size);
}

export const FORBIDDEN_COUNT = 2;

/** Pick `n` distinct random words from the item's list (hard level). */
export function pickForbidden(idiom: Idiom, n: number = FORBIDDEN_COUNT, rng: () => number = Math.random): string[] {
  return shuffle(idiom.taboo, rng).slice(0, n);
}

export function toPublic(idiom: Idiom, mode: GameMode, level: GameLevel = "hard", rng: () => number = Math.random): PublicQuestion {
  const glossary = loadGlossary();
  const card = (en: string): TabooWord => ({ en, zh: glossary[en.toLowerCase()] ?? "" });
  const forward = mode === "forward";
  const q: PublicQuestion = {
    id: idiom.id,
    tags: idiom.tags,
    difficulty: idiom.difficulty,
    hintWords: forward && level === "easy" ? idiom.taboo.map(card) : [],
    forbiddenWords: forward && level === "hard" ? pickForbidden(idiom, FORBIDDEN_COUNT, rng).map(card) : [],
  };
  if (mode === "forward") {
    q.idiom = idiom.idiom;
  } else {
    q.length = Array.from(normalizeIdiom(idiom.idiom)).length;
  }
  return q;
}
