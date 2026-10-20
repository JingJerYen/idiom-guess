import test from "node:test";
import assert from "node:assert/strict";
import { weekStart, weeklyTotals, weekLabel, type RoundEntry } from "../web/src/history.js";

test("weeks run Monday to Sunday", () => {
  assert.equal(weekStart(new Date(2026, 9, 20)).getDate(), 19); // Tue 2026-10-20 -> Mon 10/19
  assert.equal(weekStart(new Date(2026, 9, 19)).getDate(), 19); // Monday stays
  assert.equal(weekStart(new Date(2026, 9, 25)).getDate(), 19); // Sunday belongs to the week before
  assert.equal(weekStart(new Date(2026, 9, 26)).getDate(), 26); // next Monday
  assert.equal(weekLabel(new Date(2026, 9, 19)), "10/19–10/25");
});

test("weeklyTotals sums rounds per week, newest first, empty weeks included", () => {
  const now = new Date(2026, 9, 20, 15);
  const rounds: RoundEntry[] = [
    { at: new Date(2026, 9, 19, 9).getTime(), mode: "forward", level: "hard", score: 30 },
    { at: new Date(2026, 9, 20, 10).getTime(), mode: "reverse", level: "easy", score: 12 },
    { at: new Date(2026, 9, 25, 23).getTime(), mode: "forward", level: "easy", score: 99 }, // Sunday of this week, in the future but same week
    { at: new Date(2026, 9, 12).getTime(), mode: "forward", level: "hard", score: 7 }, // last week
    { at: new Date(2026, 8, 1).getTime(), mode: "forward", level: "hard", score: 50 }, // too old for a 3-week window
  ];
  const w = weeklyTotals(rounds, 3, now);
  assert.equal(w.length, 3);
  assert.deepEqual([w[0].total, w[0].rounds, w[0].best, w[0].forward, w[0].reverse], [141, 3, 99, 129, 12]);
  assert.deepEqual([w[1].total, w[1].rounds], [7, 1]);
  assert.deepEqual([w[2].total, w[2].rounds], [0, 0]);
});
