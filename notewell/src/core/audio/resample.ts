/**
 * Streaming band-limited resampler (windowed sinc, Blackman window).
 *
 * Capture devices deliver 44.1/48 kHz; Whisper and Silero VAD want 16 kHz.
 * Each output sample is computed directly from the input history, so chunk
 * boundaries never introduce clicks and arbitrary rate ratios work.
 */
export class StreamingResampler {
  private readonly step: number;
  private readonly cutoff: number;
  private readonly halfWidth: number;
  private buffer: Float32Array;
  /** Absolute input index of buffer[0]. */
  private bufferStart: number;
  /** Number of output samples produced so far. */
  private produced = 0;
  private flushed = false;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    zeroCrossings = 8,
  ) {
    if (inputRate <= 0 || outputRate <= 0) throw new RangeError("sample rates must be positive");
    this.step = inputRate / outputRate;
    // Normalised cutoff relative to the input Nyquist frequency, slightly below
    // the output Nyquist when downsampling to keep aliasing out of the band.
    this.cutoff = Math.min(1, outputRate / inputRate) * 0.95;
    this.halfWidth = Math.ceil(zeroCrossings / this.cutoff);
    // Zero history so the first output sample (t = 0) has a full kernel.
    this.buffer = new Float32Array(this.halfWidth);
    this.bufferStart = -this.halfWidth;
  }

  /** Feed input samples; returns every output sample that is now computable. */
  push(input: Float32Array): Float32Array {
    if (this.flushed) throw new Error("resampler already flushed");
    if (this.inputRate === this.outputRate) return input.slice();
    this.append(input);
    return this.drain(false);
  }

  /** Emit the tail, treating everything after the last input as silence. */
  flush(): Float32Array {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    if (this.inputRate === this.outputRate) return new Float32Array(0);
    const inputEnd = this.bufferStart + this.buffer.length;
    this.append(new Float32Array(this.halfWidth + 1));
    return this.drain(true, inputEnd);
  }

  private append(input: Float32Array): void {
    const next = new Float32Array(this.buffer.length + input.length);
    next.set(this.buffer);
    next.set(input, this.buffer.length);
    this.buffer = next;
  }

  private drain(final: boolean, inputEnd = Infinity): Float32Array {
    const out: number[] = [];
    const available = this.bufferStart + this.buffer.length;
    for (;;) {
      const center = this.produced * this.step;
      if (final ? center >= inputEnd : center + this.halfWidth >= available) break;
      out.push(this.sampleAt(center));
      this.produced++;
    }
    // Drop history that no future output sample can reach.
    const keepFrom = Math.floor(this.produced * this.step) - this.halfWidth;
    const drop = keepFrom - this.bufferStart;
    if (drop > 0) {
      this.buffer = this.buffer.slice(drop);
      this.bufferStart += drop;
    }
    return Float32Array.from(out);
  }

  private sampleAt(center: number): number {
    const first = Math.ceil(center - this.halfWidth);
    const last = Math.floor(center + this.halfWidth);
    let acc = 0;
    for (let k = first; k <= last; k++) {
      const idx = k - this.bufferStart;
      if (idx < 0 || idx >= this.buffer.length) continue;
      const t = center - k;
      acc += this.buffer[idx]! * this.kernel(t);
    }
    return acc;
  }

  private kernel(t: number): number {
    const x = t / this.halfWidth;
    if (x <= -1 || x >= 1) return 0;
    const window = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    const arg = Math.PI * this.cutoff * t;
    const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
    return this.cutoff * sinc * window;
  }
}

/** One-shot convenience wrapper around {@link StreamingResampler}. */
export function resample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input.slice();
  const r = new StreamingResampler(inputRate, outputRate);
  const head = r.push(input);
  const tail = r.flush();
  const out = new Float32Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}
