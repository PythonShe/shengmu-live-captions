class PCMTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = Math.max(1, Math.round(sampleRate / 10));
    this.buffer = new Float32Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const copyLength = Math.min(
        channel.length - sourceOffset,
        this.frameSamples - this.offset
      );
      this.buffer.set(
        channel.subarray(sourceOffset, sourceOffset + copyLength),
        this.offset
      );
      sourceOffset += copyLength;
      this.offset += copyLength;

      if (this.offset === this.frameSamples) {
        const frame = this.buffer;
        this.port.postMessage(frame, [frame.buffer]);
        this.buffer = new Float32Array(this.frameSamples);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PCMTap);
