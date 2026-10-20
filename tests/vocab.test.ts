import test from "node:test";
import assert from "node:assert/strict";
import { blankWord, exampleUsable } from "../web/src/vocab.js";

test("blankWord hides the word and its inflections", () => {
  assert.equal(blankWord("He waits for luck.", "wait"), "He ＿＿＿ for luck.");
  assert.equal(blankWord("She pretends to be strong.", "pretend"), "She ＿＿＿ to be strong.");
  assert.equal(blankWord("They were waiting.", "wait for"), "They were ＿＿＿.");
});

test("exampleUsable rejects examples that do not contain the word", () => {
  assert.equal(exampleUsable("He pretends to be strong.", "pretend"), true);
  assert.equal(exampleUsable("He acts strong, but others only fear the man behind him.", "pretend"), false);
  assert.equal(exampleUsable("", "pretend"), false);
  assert.equal(exampleUsable("   ", "pretend"), false);
});
