/**
 * Round history kept in localStorage, for weekly score totals. Each finished round is one entry.
 * Never sent to the server.
 */
import type { Level, Mode } from "./state.js";

export interface RoundEntry {
  at: number; // ms since epoch
  mode: Mode;
  level: Level;
  score: number;
}

export interface WeekTotal {
  /** Monday 00:00 local time of that week. */
  start: Date;
  total: number;
  rounds: number;
  best: number;
  forward: number;
  reverse: number;
}

const KEY = "idiom.history";
const MAX_ENTRIES = 1000;
const DAY_MS = 86_400_000;

export function listRounds(): RoundEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function isEntry(v: unknown): v is RoundEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as RoundEntry;
  return typeof e.at === "number" && typeof e.score === "number" && (e.mode === "forward" || e.mode === "reverse") && (e.level === "easy" || e.level === "hard");
}

export function recordRound(mode: Mode, level: Level, score: number, at: number = Date.now()): void {
  const rounds = listRounds();
  rounds.push({ at, mode, level, score });
  try {
    localStorage.setItem(KEY, JSON.stringify(rounds.slice(-MAX_ENTRIES)));
  } catch { /* storage unavailable */ }
}

/** Monday 00:00 (local time) of the week containing `d`. Weeks run Monday to Sunday. */
export function weekStart(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (s.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  s.setDate(s.getDate() - offset);
  return s;
}

/** Totals for the last `weeks` weeks ending with the week of `now`, newest first; empty weeks included. */
export function weeklyTotals(rounds: RoundEntry[], weeks: number, now: Date = new Date()): WeekTotal[] {
  const out: WeekTotal[] = [];
  const thisWeek = weekStart(now);
  for (let i = 0; i < weeks; i++) {
    const start = new Date(thisWeek);
    start.setDate(start.getDate() - 7 * i);
    out.push({ start, total: 0, rounds: 0, best: 0, forward: 0, reverse: 0 });
  }
  const byStart = new Map(out.map((w) => [w.start.getTime(), w]));
  for (const r of rounds) {
    const w = byStart.get(weekStart(new Date(r.at)).getTime());
    if (!w) continue;
    w.total += r.score;
    w.rounds += 1;
    w.best = Math.max(w.best, r.score);
    if (r.mode === "forward") w.forward += r.score; else w.reverse += r.score;
  }
  return out;
}

/** "10/20–10/26" for the week starting at `start`. */
export function weekLabel(start: Date): string {
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${md(start)}–${md(end)}`;
}
