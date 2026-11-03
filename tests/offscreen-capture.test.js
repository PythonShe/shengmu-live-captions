import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// offscreen.js is a classic script for a browser document, so it runs here in
// a vm context with stand-ins for tab capture, Web Audio and the WebSocket.

const SOURCE = fs.readFileSync(new URL("../extension/offscreen/offscreen.js", import.meta.url), "utf8");
const PACKET_SAMPLES = 1600; // 100 ms at 16 kHz: the fake context needs no resampling.
const PACKET_BYTES = PACKET_SAMPLES * 2;
const LIMIT_BYTES = 64 * 1024;

function loadOffscreen() {
  const messages = [];
  const sockets = [];
  let listener = null;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.bufferedAmount = 0;
      this.frames = [];
      sockets.push(this);
    }

    send(data) {
      this.frames.push(data.byteLength);
      // WhisperLiveKit answers the empty end-of-audio frame once it is done.
      if (data.byteLength === 0) {
        setImmediate(() => this.onmessage?.({ data: JSON.stringify({ type: "ready_to_stop" }) }));
      }
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }

    accept() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }
  }

  class FakeNode {
    connect() {}
    disconnect() {}
  }

  class FakeWorkletNode extends FakeNode {
    port = { onmessage: null };
  }

  class FakeAudioContext {
    sampleRate = 16000;
    state = "running";
    destination = new FakeNode();
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() {
      return new FakeNode();
    }
    createGain() {
      return Object.assign(new FakeNode(), { gain: { value: 1 } });
    }
    createOscillator() {
      return Object.assign(new FakeNode(), { frequency: { value: 0 }, start() {}, stop() {} });
    }
    async resume() {}
    async close() {
      this.state = "closed";
    }
  }

  const track = {
    label: "Tab audio",
    readyState: "live",
    muted: false,
    getSettings: () => ({}),
    getConstraints: () => ({}),
    addEventListener() {},
    stop() {}
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const context = vm.createContext({
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async (message) => {
          messages.push(structuredClone(message));
        },
        onMessage: {
          addListener: (callback) => {
            listener = callback;
          }
        }
      }
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    WebSocket: FakeWebSocket,
    URL,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  vm.runInContext(SOURCE, context, { filename: "offscreen.js" });

  function request(message) {
    return new Promise((resolve) => {
      listener({ target: "offscreen", ...message }, {}, resolve);
    });
  }

  return {
    messages,
    sockets,
    async start(sessionId) {
      const response = await request({
        type: "start-capture",
        sessionId,
        streamId: "stream",
        wsUrl: "ws://127.0.0.1:8010/asr"
      });
      assert.equal(response.ok, true, response.error);
      const socket = sockets.at(-1);
      socket.accept();
      return socket;
    },
    stop: () => request({ type: "stop-capture", quiet: true }),
    /** Clears the stats interval even when a test fails mid-capture. */
    dispose: () => vm.runInContext("cleanupAudio()", context),
    /** One worklet batch of `count` samples. */
    capture(count = PACKET_SAMPLES) {
      vm.runInContext("workletNode", context).port.onmessage({ data: new Float32Array(count).fill(0.25) });
    },
    /** The stats the 1 s interval would send next. */
    audioStats() {
      vm.runInContext("updateAudioStats()", context);
      return messages.filter((message) => message.type === "audio-stats").at(-1).audio;
    }
  };
}

test("a backed-up socket drops live packets, counts them and recovers", async (t) => {
  const offscreen = loadOffscreen();
  t.after(() => offscreen.dispose());
  const socket = await offscreen.start("s1");

  offscreen.capture();
  offscreen.capture();
  assert.deepEqual(socket.frames, [PACKET_BYTES, PACKET_BYTES]);
  assert.equal(offscreen.audioStats().droppedPackets, 0);

  // At the cap the packet still goes out; above it the packet is withheld.
  socket.bufferedAmount = LIMIT_BYTES;
  offscreen.capture();
  socket.bufferedAmount = LIMIT_BYTES + 1;
  offscreen.capture();
  offscreen.capture();
  assert.equal(socket.frames.length, 3);
  const stats = offscreen.audioStats();
  assert.equal(stats.droppedPackets, 2);
  assert.equal(stats.droppedSeconds, 0.2);
  assert.equal(stats.wsBufferedBytes, LIMIT_BYTES + 1);
  // Dropped audio was still captured: deliveredRatio stays a capture metric.
  assert.equal(stats.audioSeconds, 0.5);

  socket.bufferedAmount = 0;
  offscreen.capture();
  assert.equal(socket.frames.length, 4);

  // The tail flushed on stop is sent even while the socket is backed up.
  offscreen.capture(800);
  socket.bufferedAmount = LIMIT_BYTES * 2;
  assert.equal((await offscreen.stop()).ok, true);
  assert.deepEqual(socket.frames.slice(4), [800 * 2, 0]);
});

test("a new capture starts its drop count at zero", async (t) => {
  const offscreen = loadOffscreen();
  t.after(() => offscreen.dispose());
  const first = await offscreen.start("s1");
  first.bufferedAmount = LIMIT_BYTES + 1;
  offscreen.capture();
  assert.equal(offscreen.audioStats().droppedPackets, 1);
  first.bufferedAmount = 0;
  await offscreen.stop();

  const second = await offscreen.start("s2");
  offscreen.capture();
  assert.equal(second.frames.length, 1);
  const stats = offscreen.audioStats();
  assert.equal(stats.droppedPackets, 0);
  assert.equal(stats.droppedSeconds, 0);
  await offscreen.stop();
});
