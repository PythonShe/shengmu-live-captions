import assert from "node:assert/strict";
import test from "node:test";

import { polishTranslation, stripSpeechFillers } from "../extension/lib/speech-cleanup.js";

test("stripSpeechFillers drops interjections and comma-bounded asides", () => {
  assert.equal(
    stripSpeechFillers("Um, so I think, you know, people will be experimenting."),
    "So I think, people will be experimenting."
  );
  assert.equal(
    stripSpeechFillers("Uh, yeah, I mean, it is kind of weird."),
    "Yeah, it is weird."
  );
  assert.equal(
    stripSpeechFillers("So, um, we are, like, ready to go."),
    "So, we are, ready to go."
  );
  assert.equal(stripSpeechFillers("Hmm. That is interesting."), "That is interesting.");
  assert.equal(stripSpeechFillers("you know, that is the problem."), "that is the problem.");
});

test("stripSpeechFillers keeps phrases that are not filler", () => {
  // No comma: this is the noun "kind", not the filler phrase.
  assert.equal(stripSpeechFillers("what kind of weapon is that"), "what kind of weapon is that");
  // Clause connectors carry meaning and must survive.
  assert.equal(
    stripSpeechFillers("And riddled with excitement, he wants to learn."),
    "And riddled with excitement, he wants to learn."
  );
  assert.equal(
    stripSpeechFillers(
      "There are honestly so many options here that unlock all sorts of crazy crafting projects."
    ),
    "There are honestly so many options here that unlock all sorts of crazy crafting projects."
  );
  assert.equal(stripSpeechFillers("Really?"), "Really?");
});

test("stripSpeechFillers collapses stutters but keeps legal repeats", () => {
  assert.equal(stripSpeechFillers("I I think the the map is broken."), "I think the map is broken.");
  assert.equal(stripSpeechFillers("what that that means"), "what that that means");
  assert.equal(stripSpeechFillers("he had had enough"), "he had had enough");
});

test("stripSpeechFillers never returns empty text for a real segment", () => {
  assert.equal(stripSpeechFillers("Um."), "Um.");
  assert.equal(stripSpeechFillers(""), "");
  assert.equal(stripSpeechFillers("   "), "   ");
});

test("polishTranslation drops sentence-initial Chinese interjections", () => {
  assert.equal(polishTranslation("嗯，我觉得这个很好。"), "我觉得这个很好。");
  assert.equal(polishTranslation("那个，我们先开始吧。"), "我们先开始吧。");
  assert.equal(polishTranslation("就是说，我们走吧。"), "我们走吧。");
  assert.equal(polishTranslation("嗯嗯，对对。"), "对对。");
});

test("polishTranslation keeps in-sentence interjections and normalises punctuation", () => {
  assert.equal(polishTranslation("这可能啊有风险。"), "这可能啊有风险。");
  assert.equal(polishTranslation("好，，走吧。"), "好，走吧。");
  assert.equal(polishTranslation("真的吗！！！"), "真的吗！");
  assert.equal(polishTranslation(""), "");
});
