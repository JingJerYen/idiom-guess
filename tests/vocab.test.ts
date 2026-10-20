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

test("exportText lists words then grammar in plain text", async () => {
  const { exportText } = await import("../web/src/vocab.js");
  const txt = exportText([
    { id: "a", type: "word", word: "pretend", zh: "假裝", example: "He pretends to be strong.", source: "狐假虎威", createdAt: 0, misses: 0 },
    { id: "b", type: "grammar", title: "第三人稱單數動詞要加 s", wrong: "he wait", fixed: "He waits.", source: "守株待兔", createdAt: 0, misses: 0 },
  ], new Date(2026, 9, 20));
  assert.match(txt, /^繞著說 詞本  2026-10-20\n單字 1 個，文法 1 則\n/);
  assert.match(txt, /【單字】\npretend  假裝  （狐假虎威）\n  He pretends to be strong\./);
  assert.match(txt, /【文法】\n第三人稱單數動詞要加 s  （守株待兔）\n  ✗ he wait\n  ✓ He waits\./);
});
