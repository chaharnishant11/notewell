import { describe, expect, it } from "vitest";
import type { Transcriber } from "../asr/types.js";
import { TranscriptStore, formatClock } from "../transcript/store.js";
import type { TranscriptSegment } from "../transcript/types.js";
import type { VoiceActivityDetector } from "../vad/types.js";
import { SourcePipeline } from "./source-pipeline.js";

/** Speech iff the frame is loud; deterministic stand-in for Silero. */
class LoudnessVad implements VoiceActivityDetector {
  readonly frameSize = 512;
  async process(frame: Float32Array): Promise<number> {
    let peak = 0;
    for (const s of frame) peak = Math.max(peak, Math.abs(s));
    return peak > 0.1 ? 0.95 : 0.02;
  }
  reset(): void {}
}

/** Reports how many seconds of audio it was given. */
class DurationTranscriber implements Transcriber {
  readonly name = "fake";
  calls = 0;
  async transcribe(audio: Float32Array) {
    this.calls++;
    await new Promise((r) => setTimeout(r, 1));
    return { text: `speech ${(audio.length / 16000).toFixed(1)}s`, inferenceMs: 1 };
  }
}

function signal(pattern: [loud: boolean, seconds: number][], rate: number): Float32Array {
  const total = pattern.reduce((n, [, s]) => n + Math.round(s * rate), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const [loud, s] of pattern) {
    const n = Math.round(s * rate);
    for (let k = 0; k < n; k++, i++) out[i] = loud ? 0.5 * Math.sin((2 * Math.PI * 220 * k) / rate) : 0;
  }
  return out;
}

async function runPipeline(audio: Float32Array, rate: number, chunk = 4800, interimIntervalMs = 0) {
  const transcriber = new DurationTranscriber();
  const pipeline = new SourcePipeline({
    source: "system",
    inputRate: rate,
    vad: new LoudnessVad(),
    transcriber,
    interimIntervalMs,
  });
  const segments: TranscriptSegment[] = [];
  pipeline.on("segment", (s) => segments.push(s));
  pipeline.on("error", (e) => {
    throw e;
  });
  for (let i = 0; i < audio.length; i += chunk) pipeline.push(audio.subarray(i, i + chunk));
  await pipeline.stop();
  return { segments, transcriber };
}

describe("SourcePipeline", () => {
  it("turns two speech islands at 48 kHz into two final segments with meeting-relative times", async () => {
    const audio = signal(
      [
        [false, 1],
        [true, 2],
        [false, 1.5],
        [true, 1],
        [false, 1],
      ],
      48000,
    );
    const { segments } = await runPipeline(audio, 48000);
    const finals = segments.filter((s) => s.final);
    expect(finals).toHaveLength(2);
    expect(finals[0]!.source).toBe("system");
    // pre-roll (300 ms) before the first island at 1.0 s
    expect(finals[0]!.startMs).toBeGreaterThanOrEqual(650);
    expect(finals[0]!.startMs).toBeLessThanOrEqual(1000);
    expect(finals[1]!.startMs).toBeGreaterThan(4000);
    expect(new Set(finals.map((s) => s.id)).size).toBe(2);
  });

  it("emits interim results that share the final segment's id", async () => {
    const audio = signal(
      [
        [true, 5],
        [false, 1],
      ],
      16000,
    );
    const { segments } = await runPipeline(audio, 16000, 1600, 1000);
    const interim = segments.filter((s) => !s.final);
    const finals = segments.filter((s) => s.final);
    expect(interim.length).toBeGreaterThan(0);
    expect(finals).toHaveLength(1);
    expect(interim.every((s) => s.id === finals[0]!.id)).toBe(true);
  });

  it("splits a monologue at the max utterance length", async () => {
    const audio = signal([[true, 35]], 16000);
    const { segments } = await runPipeline(audio, 16000, 16000);
    expect(segments.filter((s) => s.final).length).toBe(3); // 15 s + 15 s + 5 s
  });
});

describe("TranscriptStore", () => {
  const seg = (id: string, source: TranscriptSegment["source"], startMs: number, text: string, final = true) => ({
    id,
    source,
    startMs,
    endMs: startMs + 1000,
    text,
    final,
  });

  it("orders by time, replaces interim text and never downgrades a final", () => {
    const store = new TranscriptStore();
    store.upsert(seg("b", "system", 5000, "Hi there", false));
    store.upsert(seg("a", "microphone", 1000, "Hello"));
    store.upsert(seg("b", "system", 5000, "Hi there, everyone"));
    expect(store.upsert(seg("b", "system", 5000, "stale", false))).toBe(false);
    expect(store.segments().map((s) => s.text)).toEqual(["Hello", "Hi there, everyone"]);
  });

  it("drops utterances whose final text is empty", () => {
    const store = new TranscriptStore();
    store.upsert(seg("x", "system", 0, "uh", false));
    store.upsert(seg("x", "system", 0, ""));
    expect(store.segments()).toHaveLength(0);
  });

  it("renders speaker turns, merging consecutive segments", () => {
    const store = new TranscriptStore([
      seg("1", "microphone", 0, "Morning."),
      seg("2", "system", 2000, "Hey!"),
      seg("3", "system", 4000, "Ready to start?"),
      seg("4", "microphone", 61000, "Yes."),
    ]);
    expect(store.toText({ timestamps: true })).toBe(
      "[00:00] Me: Morning.\n[00:02] Them: Hey! Ready to start?\n[01:01] Me: Yes.",
    );
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
});
