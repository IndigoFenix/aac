// client-aac/src/lib/pcm-player-worklet.js
//
// Continuous PCM sink for streamed TTS. ONE processor lives for ONE utterance
// and drains a jitter buffer that the main thread keeps topping up.
//
// This exists because the previous streaming attempt was choppy: the player
// decoded each arriving network chunk as a STANDALONE compressed file and
// played it as its own AudioBufferSourceNode / <audio> src. Arbitrary
// byte-range slices of an MP3 stream are not independently decodable — each
// one got cut at a frame boundary, re-primed the decoder, and was scheduled
// as a separate source, so every chunk boundary was an audible seam.
//
// Here the main thread sends raw Float32 PCM already resampled to the context
// rate, and this processor emits ONE unbroken signal. There are no chunk
// boundaries in the output — a slow network shows up as a jitter-buffer
// underrun (brief silence), never as a click or a re-primed decoder.
//
// Loaded as a Vite asset URL (see pcmStreamSink.ts) rather than a blob URL so
// it stays same-origin under the Electron `app://aac` and Capacitor origins,
// where a blob: worklet can trip CSP.

/* eslint-disable no-undef */

class PcmSinkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    // Frames of audio to accumulate before starting playback (and after an
    // underrun, before resuming). This is the entire anti-choppiness budget:
    // too low and jitter is audible, too high and the utterance feels late.
    this.prebufferFrames = opts.prebufferFrames || 0;

    /** @type {Float32Array[]} pending audio, oldest first */
    this.blocks = [];
    /** Read cursor into blocks[0]. */
    this.readOffset = 0;
    /** Frames currently held across all blocks (minus readOffset). */
    this.buffered = 0;

    /** Main thread has sent everything; drain and finish. */
    this.ended = false;
    /** Past the prebuffer gate — actively draining. */
    this.started = false;
    /** 'ended' already posted; process() is about to return false. */
    this.finished = false;
    /** Diagnostics: how many times we ran dry mid-utterance. */
    this.underruns = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      switch (msg.type) {
        case "push": {
          const block = msg.samples instanceof Float32Array
            ? msg.samples
            : new Float32Array(msg.samples);
          if (block.length === 0) return;
          this.blocks.push(block);
          this.buffered += block.length;
          break;
        }
        case "end":
          this.ended = true;
          break;
        case "abort":
          this.blocks = [];
          this.readOffset = 0;
          this.buffered = 0;
          this.ended = true;
          break;
        default:
          break;
      }
    };
  }

  /** Pull up to `count` frames into `out` starting at `offset`. Returns frames written. */
  drain(out, offset, count) {
    let written = 0;
    while (written < count && this.blocks.length > 0) {
      const block = this.blocks[0];
      const available = block.length - this.readOffset;
      const take = Math.min(available, count - written);
      out.set(block.subarray(this.readOffset, this.readOffset + take), offset + written);
      this.readOffset += take;
      written += take;
      this.buffered -= take;
      if (this.readOffset >= block.length) {
        this.blocks.shift();
        this.readOffset = 0;
      }
    }
    return written;
  }

  process(_inputs, outputs) {
    if (this.finished) return false;

    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    const frames = channel.length;

    // Prebuffer gate. Applies at start AND after an underrun, which turns a
    // burst of tiny gaps into one short pause — far less jarring than stutter.
    if (!this.started) {
      // `buffered > 0` is required even when prebufferFrames is 0 (cache hits):
      // port.postMessage is async, so the first process() can fire before any
      // audio has landed, and starting on an empty buffer would immediately
      // count a spurious underrun.
      if (this.buffered > 0 && (this.buffered >= this.prebufferFrames || this.ended)) {
        this.started = true;
      } else if (this.ended && this.buffered === 0) {
        // Nothing ever arrived (aborted or empty synthesis) — finish quietly.
        this.finished = true;
        this.port.postMessage({ type: "ended", underruns: this.underruns });
        return false;
      } else {
        channel.fill(0);
        this.fanOut(output, channel);
        return true;
      }
    }

    const written = this.drain(channel, 0, frames);

    if (written < frames) {
      // Ran dry. If the stream is closed this is the natural tail; otherwise
      // it's an underrun and we re-arm the prebuffer gate.
      channel.fill(0, written);
      if (this.ended && this.buffered === 0) {
        this.finished = true;
        this.fanOut(output, channel);
        this.port.postMessage({ type: "ended", underruns: this.underruns });
        return false;
      }
      this.underruns++;
      this.started = false;
    }

    this.fanOut(output, channel);
    return true;
  }

  /** Mirror channel 0 across any additional output channels (mono source). */
  fanOut(output, channel) {
    for (let c = 1; c < output.length; c++) output[c].set(channel);
  }
}

registerProcessor("pcm-sink", PcmSinkProcessor);
