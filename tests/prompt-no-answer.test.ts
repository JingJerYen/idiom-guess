import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGuessSystemPrompt, buildGuessUserMessage } from "../src/prompts/guess.js";
import { allTags, loadIdioms } from "../src/game/idioms.js";

const idioms = loadIdioms();
const tags = allTags(idioms);
const GUESS_SYSTEM_PROMPT = buildGuessSystemPrompt(tags);

test("guess prompt contains no idiom, alias, pinyin or taboo list from the bank", () => {
  const user = buildGuessUserMessage({ descriptions: ["Someone adds useless extras and ruins a finished job."] });
  const full = GUESS_SYSTEM_PROMPT + "\n" + user;
  for (const it of idioms) {
    assert.equal(full.includes(it.idiom), false, `prompt leaks ${it.idiom}`);
    for (const a of it.aliases) assert.equal(full.includes(a), false, `prompt leaks alias ${a}`);
    assert.equal(full.toLowerCase().includes(it.pinyin), false, `prompt leaks pinyin ${it.pinyin}`);
    assert.equal(full.includes(it.reference_english), false, `prompt leaks reference for ${it.idiom}`);
  }
  // The only Han text allowed is the list of possible kinds (tags), which is deliberately shared.
  const han = (full.match(/\p{Script=Han}+/gu) ?? []).filter((w) => !tags.includes(w));
  assert.deepEqual(han, []);
});

test("guess system prompt lists every kind in the bank but cannot single out the current item's kind", () => {
  for (const t of tags) assert.ok(GUESS_SYSTEM_PROMPT.includes(t), `missing kind ${t}`);
  // The same system prompt is used for every item, so it carries no per-item information.
  assert.equal(buildGuessSystemPrompt(tags), GUESS_SYSTEM_PROMPT);
});

test("with earlier guesses, the prompt reveals only confirmed characters, never the whole answer", () => {
  const target = idioms.find((i) => i.idiom === "亡羊補牢")!;
  const user = buildGuessUserMessage({
    descriptions: ["first try", "second try"],
    previousGuesses: [{ guess: "亡羊之歎", confirmed: ["亡", "羊", null, null] }],
  });
  assert.ok(user.includes('<previous_guess n="1">亡羊之歎</previous_guess>'));
  assert.ok(user.includes("1st = 亡, 2nd = 羊"));
  assert.equal(user.includes(target.idiom), false, "full answer must not appear");
  assert.equal(user.includes("補"), false);
  assert.equal(user.includes("牢"), false);
  const han = Array.from(new Set(user.match(/\p{Script=Han}/gu) ?? [])).sort();
  assert.deepEqual(han, ["之", "亡", "歎", "羊"]);
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
  assert.ok(/guessIdiom\(body\.descriptions, previousGuesses\)/.test(src), "guessIdiom must be called with descriptions and the AI's own earlier guesses only");
  assert.equal(/guessIdiom\([^)]*idiom\b/.test(src), false, "the idiom object must never be passed to the guesser");
});
