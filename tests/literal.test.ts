import { test } from "node:test";
import assert from "node:assert/strict";
import { literalHints, numbersIn, pickLiteralHint } from "../src/game/literal.js";
import { loadIdioms } from "../src/game/idioms.js";
import { buildDescribeUserMessage } from "../src/prompts/describe.js";

test("literal hints are found by character with a category and gloss", () => {
  const h = literalHints("狐假虎威");
  assert.deepEqual(h.map((x) => [x.index, x.char, x.category, x.english]), [[0, "狐", "animal", "fox"], [2, "虎", "animal", "tiger"]]);
  assert.deepEqual(numbersIn("一箭雙鵰"), ["一", "雙"]);
  assert.deepEqual(numbersIn("狐假虎威"), []);
});

test("pickLiteralHint prefers a position the player has not been shown, numbers first", () => {
  assert.equal(pickLiteralHint("一箭雙鵰")?.char, "一");
  assert.equal(pickLiteralHint("一箭雙鵰", [0])?.char, "雙");
  assert.equal(pickLiteralHint("狐假虎威", [0])?.char, "虎");
  assert.equal(pickLiteralHint("狐假虎威", [0, 2])?.char, "狐", "falls back to a shown position rather than nothing");
  assert.equal(pickLiteralHint("自相矛盾")?.char, "矛");
  assert.equal(pickLiteralHint("整人節目")?.char, "目", "body parts rank before persons (the route skips non-idiom terms anyway)");
});

test("the final-clue prompt states the fact and the absence of numbers; it never invites guessing", () => {
  const base = { idiom: "狐假虎威", tags: ["成語"], referenceEnglish: "x", forbidden: [], attempt: 3, isLast: true, previousClues: [] };
  const withFact = buildDescribeUserMessage({ ...base, literal: { position: 2, category: "an animal", english: "tiger" }, numbers: [] });
  assert.ok(withFact.includes('LITERAL FACT: the 3rd character means "tiger" (an animal)'));
  assert.ok(withFact.includes("contains NO number"));
  const none = buildDescribeUserMessage({ ...base, literal: null, numbers: [] });
  assert.ok(none.includes("LITERAL FACT: none"));
  const notLast = buildDescribeUserMessage({ ...base, isLast: false });
  assert.equal(notLast.includes("LITERAL FACT"), false);
});

test("dictionary coverage of the bank is reported", () => {
  const all = loadIdioms();
  const covered = all.filter((i) => literalHints(i.idiom).length > 0).length;
  console.log(`literal coverage: ${covered}/${all.length} terms have at least one concrete character`);
  assert.ok(covered / all.length > 0.5, "most terms should have a concrete character");
});
