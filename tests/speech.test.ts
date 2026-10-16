import { test } from "node:test";
import assert from "node:assert/strict";
import { joinOverlap } from "../web/src/speech.js";

test("joinOverlap drops words the interim repeats from the final text", () => {
  assert.equal(joinOverlap("play", "play piano"), "play piano");
  assert.equal(joinOverlap("Someone adds extra", "adds extra details"), "Someone adds extra details");
  assert.equal(joinOverlap("I like to play", "Play the piano"), "I like to play the piano");
});

test("joinOverlap keeps unrelated text and handles empties", () => {
  assert.equal(joinOverlap("hello there", "general kenobi"), "hello there general kenobi");
  assert.equal(joinOverlap("", "play piano"), "play piano");
  assert.equal(joinOverlap("play piano", ""), "play piano");
  assert.equal(joinOverlap("play piano", "play piano"), "play piano");
});
