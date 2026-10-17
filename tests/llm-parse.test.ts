import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, parseWithSchema, salvageGuess } from "../src/llm/callJson.js";
import { FeedbackResultSchema, GuessResultSchema } from "../src/llm/types.js";
import { mockGuess, mockFeedback, mockPerfectSentence } from "../src/llm/mock.js";
import { loadIdioms } from "../src/game/idioms.js";

test("parses a clean JSON reply", () => {
  const r = parseWithSchema('{"guess":"畫蛇添足","reason":"Adding extras ruins it.","perfect_sentence":true,"grammar_note":""}', GuessResultSchema);
  assert.equal(r.guess, "畫蛇添足");
  assert.equal(r.perfect_sentence, true);
});

test("grammar fields are optional and default to not-perfect", () => {
  const r = parseWithSchema('{"guess":"畫蛇添足","reason":"x"}', GuessResultSchema);
  assert.equal(r.perfect_sentence, false);
  assert.equal(r.grammar_note, "");
  assert.throws(() => parseWithSchema('{"guess":"畫蛇添足","reason":"x","perfect_sentence":"yes"}', GuessResultSchema), SyntaxError);
});

test("salvageGuess recovers the guess from a truncated reply", () => {
  const cut = '{"guess": "守株待兔", "reason": "The player describes waiting for luck instead of wor';
  const s = salvageGuess(cut) as { guess: string; reason: string; perfect_sentence: boolean };
  assert.equal(s.guess, "守株待兔");
  assert.equal(s.reason, "The player describes waiting for luck instead of wor");
  assert.equal(s.perfect_sentence, false);
  assert.ok(GuessResultSchema.safeParse(s).success, "salvaged object must satisfy the schema");
  // a reply with the whole flag present keeps it
  assert.equal((salvageGuess('{"guess":"台北101","reason":"x","perfect_sentence":true,"grammar_note":"this is a long note that never clo') as { perfect_sentence: boolean }).perfect_sentence, true);
  // nothing usable
  assert.equal(salvageGuess("I think it is 守株待兔"), null);
  assert.equal(salvageGuess('{"gu'), null);
});

test("mock grammar heuristic", () => {
  assert.equal(mockPerfectSentence("Someone adds useless extras to a job that was already finished.").perfect, true);
  assert.equal(mockPerfectSentence("someone adds useless extras to a finished job.").perfect, false);
  assert.equal(mockPerfectSentence("Someone adds useless extras to a finished job").perfect, false);
});

test("tolerates code fences and surrounding chatter", () => {
  const text = 'Sure! Here you go:\n```json\n{"guess": "守株待兔", "reason": "Waiting for luck."}\n```\nHope that helps.';
  const r = parseWithSchema(text, GuessResultSchema);
  assert.equal(r.guess, "守株待兔");
});

test("throws SyntaxError when there is no JSON object", () => {
  assert.throws(() => extractJsonObject("I think it is 守株待兔."), SyntaxError);
});

test("throws SyntaxError on truncated JSON (e.g. max_tokens cut-off)", () => {
  assert.throws(() => parseWithSchema('{"guess":"守株待兔","reason":"Wai', GuessResultSchema), SyntaxError);
});

test("throws SyntaxError when JSON does not match the schema", () => {
  assert.throws(() => parseWithSchema('{"guess":"","reason":"x"}', GuessResultSchema), SyntaxError);
  assert.throws(() => parseWithSchema('{"idiom":"守株待兔"}', GuessResultSchema), SyntaxError);
  assert.throws(() => parseWithSchema('{"corrections":"not an array"}', FeedbackResultSchema), SyntaxError);
});

test("feedback schema accepts the documented shape", () => {
  const r = parseWithSchema('{"corrections":["Someone adds extra things.","It is fine."]}', FeedbackResultSchema);
  assert.equal(r.corrections.length, 2);
});

test("mock guess always returns a four-character idiom from the bank", () => {
  const idioms = new Set(loadIdioms().map((i) => i.idiom));
  for (const d of ["random words that match nothing at all", "Adding something unnecessary ruins a fine thing"]) {
    const g = mockGuess([d]);
    assert.ok(idioms.has(g.guess), g.guess);
    assert.ok(g.reason.length > 0);
  }
  const fb = mockFeedback(loadIdioms()[0], ["someone adds extra things and i like it"]);
  assert.ok(FeedbackResultSchema.safeParse(fb).success);
  assert.deepEqual(fb.corrections, ["Someone adds extra things and I like it."]);
});
