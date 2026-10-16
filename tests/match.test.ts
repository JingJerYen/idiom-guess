import { test } from "node:test";
import assert from "node:assert/strict";
import { isCorrectGuess, normalizeIdiom } from "../src/game/match.js";
import { loadIdioms, pickRound, toPublic } from "../src/game/idioms.js";
import type { Idiom } from "../src/game/idioms.js";

const yaMiao: Idiom = {
  id: "ya-miao-zhu-zhang",
  idiom: "揠苗助長",
  aliases: ["拔苗助長"],
  pinyin: "ya miao zhu zhang",
  taboo: [],
  difficulty: 2,
  reference_english: "x",
};

test("exact match", () => {
  assert.equal(isCorrectGuess("揠苗助長", yaMiao), true);
});

test("simplified characters are normalized to traditional", () => {
  assert.equal(isCorrectGuess("揠苗助长", yaMiao), true);
  assert.equal(normalizeIdiom("画蛇添足"), "畫蛇添足");
});

test("whitespace and punctuation are ignored", () => {
  assert.equal(isCorrectGuess(" 揠苗 助長。", yaMiao), true);
  assert.equal(isCorrectGuess("「揠苗助長」", yaMiao), true);
});

test("aliases are accepted", () => {
  assert.equal(isCorrectGuess("拔苗助长", yaMiao), true);
});

test("wrong or empty guesses are rejected", () => {
  assert.equal(isCorrectGuess("守株待兔", yaMiao), false);
  assert.equal(isCorrectGuess("", yaMiao), false);
  assert.equal(isCorrectGuess("揠苗", yaMiao), false);
});

test("question bank loads and every idiom has valid data", () => {
  const all = loadIdioms();
  assert.equal(all.length, 20);
  for (const it of all) {
    assert.ok(it.taboo.length >= 3, `${it.idiom} needs taboo words`);
    assert.ok(/^[a-z ]+$/.test(it.pinyin), `${it.idiom} pinyin should be plain lowercase`);
  }
});

test("a round has 10 unique questions sorted easy to hard", () => {
  let seed = 42;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const round = pickRound(loadIdioms(), 10, rng);
  assert.equal(round.length, 10);
  assert.equal(new Set(round.map((r) => r.id)).size, 10);
  for (let i = 1; i < round.length; i++) {
    assert.ok(round[i].difficulty >= round[i - 1].difficulty);
  }
});

test("public question never leaks pinyin or reference; reverse hides the idiom", () => {
  const it = loadIdioms()[0];
  const fwd = toPublic(it, "forward") as Record<string, unknown>;
  assert.equal(fwd.idiom, it.idiom);
  assert.equal("pinyin" in fwd, false);
  assert.equal("reference_english" in fwd, false);
  const rev = toPublic(it, "reverse") as Record<string, unknown>;
  assert.equal("idiom" in rev, false);
});
