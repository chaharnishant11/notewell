import { describe, expect, it } from "vitest";
import { Framer } from "./framer.js";
import { dbfs, downmix, float32ToInt16, int16ToFloat32 } from "./pcm.js";
import { StreamingResampler, resample } from "./resample.js";
import { decodeWav, encodeWav } from "./wav.js";

function tone(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Estimate the dominant frequency by counting zero crossings. */
function zeroCrossingFreq(samples: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings++;
  }
  return (crossings / 2) * (rate / samples.length);
}

describe("pcm", () => {
  it("round-trips int16 <-> float32 within one LSB", () => {
    const src = Int16Array.from([-32768, -1, 0, 1, 12345, 32767]);
    const back = float32ToInt16(int16ToFloat32(src));
    for (let i = 0; i < src.length; i++) expect(Math.abs(back[i]! - src[i]!)).toBeLessThanOrEqual(1);
  });

  it("downmixes by averaging and reports level in dBFS", () => {
    const mixed = downmix([Float32Array.from([1, 0]), Float32Array.from([0, 0])]);
    expect(Array.from(mixed)).toEqual([0.5, 0]);
    expect(dbfs(new Float32Array(100))).toBe(-100);
    expect(dbfs(new Float32Array(100).fill(1))).toBeCloseTo(0, 5);
  });
});

describe("wav", () => {
  it("encodes and decodes 16-bit mono", () => {
    const src = tone(440, 16000, 0.1);
    const decoded = decodeWav(encodeWav(src, 16000));
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toHaveLength(1);
    expect(decoded.channels[0]!.length).toBe(src.length);
    for (let i = 0; i < src.length; i += 97) expect(decoded.channels[0]![i]).toBeCloseTo(src[i]!, 3);
  });

  it("decodes interleaved stereo float32", () => {
    const frames = 4;
    const bytes = new Uint8Array(44 + frames * 2 * 4);
    const view = new DataView(bytes.buffer);
    const w = (o: number, s: string) => [...s].forEach((ch, i) => (bytes[o + i] = ch.charCodeAt(0)));
    w(0, "RIFF");
    view.setUint32(4, bytes.length - 8, true);
    w(8, "WAVE");
    w(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint16(34, 32, true);
    w(36, "data");
    view.setUint32(40, frames * 8, true);
    for (let f = 0; f < frames; f++) {
      view.setFloat32(44 + f * 8, f / 10, true);
      view.setFloat32(48 + f * 8, -f / 10, true);
    }
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels[0]![3]).toBeCloseTo(0.3, 6);
    expect(decoded.channels[1]![3]).toBeCloseTo(-0.3, 6);
  });

  it("rejects non-WAV input", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
  });
});

describe("resample", () => {
  it.each([
    [48000, 16000],
    [44100, 16000],
    [8000, 16000],
  ])("preserves a 440 Hz tone from %i to %i Hz", (from, to) => {
    const out = resample(tone(440, from, 1), from, to);
    expect(out.length).toBeGreaterThanOrEqual(to - 1);
    expect(out.length).toBeLessThanOrEqual(to + 1);
    expect(zeroCrossingFreq(out.subarray(1000, out.length - 1000), to)).toBeCloseTo(440, -1);
  });

  it("removes content above the new Nyquist frequency", () => {
    const out = resample(tone(12000, 48000, 1), 48000, 16000);
    expect(dbfs(out.subarray(500, out.length - 500))).toBeLessThan(-40);
  });

  it("produces identical output whether fed at once or in odd-sized chunks", () => {
    const src = tone(300, 44100, 0.5);
    const whole = resample(src, 44100, 16000);
    const r = new StreamingResampler(44100, 16000);
    const parts: number[] = [];
    for (let i = 0; i < src.length; i += 777) parts.push(...r.push(src.subarray(i, i + 777)));
    parts.push(...r.flush());
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 53) expect(parts[i]).toBeCloseTo(whole[i]!, 6);
  });
});

describe("Framer", () => {
  it("emits fixed frames and pads the tail", () => {
    const framer = new Framer(4);
    expect(framer.push(Float32Array.from([1, 2, 3]))).toHaveLength(0);
    const frames = framer.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(framer.flush()!)).toEqual([9, 0, 0, 0]);
    expect(framer.flush()).toBeUndefined();
  });
});
