import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const workletSource = readFileSync(
  new URL("../extension/offscreen/pcm-worklet.js", import.meta.url),
  "utf8"
);

function loadProcessor(sampleRate = 48_000) {
  const messages = [];
  let Processor = null;

  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = {
        postMessage(value) {
          messages.push(value);
        }
      };
    }
  }

  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Float32Array,
    Math,
    registerProcessor(name, implementation) {
      assert.equal(name, "pcm-tap");
      Processor = implementation;
    },
    sampleRate
  });

  return {
    messages,
    processor: new Processor()
  };
}

test("pcm worklet batches audio into 100 ms messages without reordering samples", () => {
  const { messages, processor } = loadProcessor();
  const blockCount = 375;

  for (let block = 0; block < blockCount; block += 1) {
    const channel = new Float32Array(128);
    for (let offset = 0; offset < channel.length; offset += 1) {
      channel[offset] = block * channel.length + offset;
    }
    assert.equal(processor.process([[channel]]), true);
  }

  assert.equal(messages.length, 10);
  assert.equal(messages[0].length, 4_800);
  assert.equal(messages[0][0], 0);
  assert.equal(messages[0][4_799], 4_799);
  assert.equal(messages[9].length, 4_800);
  assert.equal(messages[9][0], 43_200);
  assert.equal(messages[9][4_799], 47_999);
});
