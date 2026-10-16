import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDescription,
  findTabooWords,
  containsPinyin,
  countEnglishWords,
} from "../src/game/validate.js";
import type { Idiom } from "../src/game/idioms.js";

const huaShe: Idiom = {
  id: "hua-she-tian-zu",
  idiom: "畫蛇添足",
  aliases: ["画蛇添足"],
  tags: ["成語"],
  pinyin: "hua she tian zu",
  taboo: ["snake", "foot", "feet", "leg", "draw"],
  difficulty: 1,
  reference_english: "x",
};

test("accepts a clean description", () => {
  const r = validateDescription(
    "Someone ruins a finished job by adding extra details that nobody needed.",
    huaShe,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("rejects Chinese characters and reports them", () => {
  const r = validateDescription("This is about a 蛇 that has legs", huaShe);
  const v = r.violations.find((x) => x.type === "chinese");
  assert.ok(v && v.type === "chinese");
  assert.deepEqual(v.chars, ["蛇"]);
  assert.equal(r.violations.some((x) => x.type === "taboo"), false, "taboo is no longer a violation");
});

test("hint words are never enforced; Chinese and pinyin still are", () => {
  const r = validateDescription("A snake gets extra legs and that ruins the drawing completely", huaShe);
  assert.equal(r.ok, true);
  const r2 = validateDescription("A snake 蛇 gets extra legs and that ruins it", huaShe);
  assert.deepEqual(r2.violations.map((v) => v.type), ["chinese"]);
});

test("regular inflections are matched from the base form only", () => {
  assert.deepEqual(findTabooWords("He moved it while carving and digging", ["move", "carve", "dig"]), ["move", "carve", "dig"]);
  assert.deepEqual(findTabooWords("She worried and worries a lot", ["worry"]), ["worry"]);
  assert.deepEqual(findTabooWords("They were waiting and borrowed it", ["wait", "borrow"]), ["wait", "borrow"]);
  // irregular forms still need their own entry
  assert.deepEqual(findTabooWords("my feet hurt", ["foot"]), []);
  assert.deepEqual(findTabooWords("my feet hurt", ["foot", "feet"]), ["feet"]);
  // no false positives on longer words
  assert.deepEqual(findTabooWords("the mover was moving slowly", ["move"]), ["move"]);
  assert.deepEqual(findTabooWords("a movement began", ["move"]), []);
});

test("rejects taboo words as whole words with simple inflections", () => {
  assert.deepEqual(findTabooWords("Two snakes were drawing legs", huaShe.taboo), ["snake", "leg", "draw"]);
  // "snakeskin" is not the word "snake"; "footnote" is not "foot"
  assert.deepEqual(findTabooWords("snakeskin footnote", huaShe.taboo), []);
  assert.deepEqual(findTabooWords("SNAKE!", huaShe.taboo), ["snake"]);
});

test("taboo multi-word phrases match across whitespace", () => {
  assert.deepEqual(findTabooWords("an old   man lost it", ["old man", "horse"]), ["old man"]);
});

test("pinyin: only the full idiom pinyin is forbidden, not single syllables", () => {
  assert.equal(containsPinyin("she said it was fine", huaShe.pinyin), false);
  assert.equal(containsPinyin("the answer is hua she tian zu", huaShe.pinyin), true);
  assert.equal(containsPinyin("it is huashetianzu basically", huaShe.pinyin), true);
  assert.equal(containsPinyin("Huà Shé Tiān Zú", huaShe.pinyin), true);
  assert.equal(containsPinyin("hua2 she2 tian1 zu2", huaShe.pinyin), true);
});

test("rejects descriptions with fewer than 5 English words", () => {
  assert.equal(countEnglishWords("a quick-witted person's idea"), 4);
  const r = validateDescription("adding too much", huaShe);
  assert.ok(r.violations.some((v) => v.type === "too_short"));
});

test("rejects descriptions longer than 300 characters", () => {
  const r = validateDescription("word ".repeat(70), huaShe);
  assert.ok(r.violations.some((v) => v.type === "too_long"));
});

test("rejects empty input", () => {
  assert.deepEqual(validateDescription("   ", huaShe).violations, [{ type: "empty" }]);
});

test("taboo entries with digits or multi-word names match too", () => {
  assert.deepEqual(findTabooWords("the famous 50 lan shop", ["fifty", "50", "lan"]), ["50", "lan"]);
  assert.deepEqual(findTabooWords("it is 101 floors tall", ["101", "taipei"]), ["101"]);
  assert.deepEqual(findTabooWords("about 1010 things", ["101"]), []);
});
