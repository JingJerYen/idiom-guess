import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

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
  /** Present in forward mode only; in reverse mode tags are revealed when the question ends. */
  tags?: string[];
  difficulty: 1 | 2 | 3;
  /** Shown on screen so the player knows what not to say. */
  tabooWords: string[];
}

export type GameMode = "forward" | "reverse";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(here, "../../data/idioms.json");

let cache: Idiom[] | null = null;

export function loadIdioms(path: string = DATA_PATH): Idiom[] {
  if (cache && path === DATA_PATH) return cache;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = z.array(IdiomSchema).min(1).parse(raw);
  const ids = new Set<string>();
  for (const it of list) {
    if (ids.has(it.id)) throw new Error(`Duplicate idiom id: ${it.id}`);
    ids.add(it.id);
  }
  if (path === DATA_PATH) cache = list;
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

export function toPublic(idiom: Idiom, mode: GameMode): PublicQuestion {
  const q: PublicQuestion = {
    id: idiom.id,
    difficulty: idiom.difficulty,
    tabooWords: idiom.taboo,
  };
  if (mode === "forward") {
    q.idiom = idiom.idiom;
    q.tags = idiom.tags;
  }
  return q;
}
