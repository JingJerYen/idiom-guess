import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUESS_SYSTEM_PROMPT, buildGuessUserMessage } from "../src/prompts/guess.js";
import { loadIdioms } from "../src/game/idioms.js";

const idioms = loadIdioms();

test("guess prompt contains no idiom, alias, pinyin or taboo list from the bank", () => {
  const user = buildGuessUserMessage({ descriptions: ["Someone adds useless extras and ruins a finished job."] });
  const full = GUESS_SYSTEM_PROMPT + "\n" + user;
  for (const it of idioms) {
    assert.equal(full.includes(it.idiom), false, `prompt leaks ${it.idiom}`);
    for (const a of it.aliases) assert.equal(full.includes(a), false, `prompt leaks alias ${a}`);
    assert.equal(full.toLowerCase().includes(it.pinyin), false, `prompt leaks pinyin ${it.pinyin}`);
    assert.equal(full.includes(it.reference_english), false, `prompt leaks reference for ${it.idiom}`);
  }
  // No Han characters at all except the word 成語 used to name the game concept.
  const han = (full.match(/\p{Script=Han}+/gu) ?? []).filter((w) => w !== "成語");
  assert.deepEqual(han, []);
});

test("guess prompt wraps player text as data and includes every prior description", () => {
  const descs = ["first attempt here", "second attempt with more detail"];
  const user = buildGuessUserMessage({ descriptions: descs });
  for (const d of descs) assert.ok(user.includes(`\n${d}\n</description>`));
  assert.ok(user.includes('<description n="1">'));
  assert.ok(user.includes('<description n="2">'));
});

test("guess prompt module never imports the question bank", () => {
  const src = readFileSync(new URL("../src/prompts/guess.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["'].*idioms/.test(src), false);
  assert.equal(/idioms\.json/.test(src), false);
});

test("guess route handler passes only descriptions to the guesser", () => {
  const src = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");
  assert.ok(/guessIdiom\(body\.descriptions\)/.test(src), "guessIdiom must be called with descriptions only");
});
