import { describe, expect, it } from "vitest";
import { EnergyVad } from "./energy.js";
import { UtteranceSegmenter, type SegmentEvent } from "./segmenter.js";

const RATE = 16000;
const FRAME = 512; // 32 ms

function run(segmenter: UtteranceSegmenter, probs: number[]): SegmentEvent[] {
  const events: SegmentEvent[] = [];
  probs.forEach((p, i) => events.push(...segmenter.push(new Float32Array(FRAME).fill(i), p)));
  return events;
}

const utterances = (events: SegmentEvent[]) => events.filter((e) => e.type === "utterance");

describe("UtteranceSegmenter", () => {
  const base = { sampleRate: RATE, frameSize: FRAME, minSpeechMs: 64, minSilenceMs: 96, preRollMs: 64, postRollMs: 32 };

  it("emits one utterance per speech island with pre-roll and post-roll", () => {
    const seg = new UtteranceSegmenter(base);
    // frames: 0-4 silence, 5-9 speech, 10-13 silence
    const probs = [0, 0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0];
    const events = run(seg, probs);
    expect(events[0]).toEqual({ type: "speech-start", startSample: 3 * FRAME });
    const [u] = utterances(events);
    expect(u).toMatchObject({ reason: "silence", startSample: 3 * FRAME });
    // 2 pre-roll + 5 speech + 1 post-roll frames
    expect(u!.type === "utterance" && u!.audio.length).toBe(8 * FRAME);
    expect(u!.type === "utterance" && u!.endSample).toBe(11 * FRAME);
  });

  it("uses hysteresis so dips between start and end thresholds do not split speech", () => {
    const seg = new UtteranceSegmenter(base);
    const probs = [0.9, 0.4, 0.4, 0.4, 0.4, 0.9, 0, 0, 0];
    expect(utterances(run(seg, probs))).toHaveLength(1);
  });

  it("discards blips shorter than minSpeechMs", () => {
    const seg = new UtteranceSegmenter({ ...base, minSpeechMs: 200 });
    expect(utterances(run(seg, [0, 0.9, 0, 0, 0, 0]))).toHaveLength(0);
  });

  it("cuts long monologues at maxUtteranceMs and keeps timestamps contiguous", () => {
    const seg = new UtteranceSegmenter({ ...base, maxUtteranceMs: 320 }); // 10 frames
    const events = run(seg, new Array(25).fill(0.9));
    events.push(...seg.flush());
    const us = utterances(events).filter((e) => e.type === "utterance");
    expect(us.map((u) => u.reason)).toEqual(["max-length", "max-length", "flush"]);
    for (let i = 1; i < us.length; i++) expect(us[i]!.startSample).toBe(us[i - 1]!.endSample);
    expect(us.at(-1)!.endSample).toBe(25 * FRAME);
  });

  it("exposes the open utterance for interim transcription", () => {
    const seg = new UtteranceSegmenter(base);
    run(seg, [0.9, 0.9, 0.9]);
    expect(seg.isSpeaking).toBe(true);
    expect(seg.activeUtterance()!.audio.length).toBe(3 * FRAME);
  });
});

describe("EnergyVad", () => {
  it("separates a loud tone from near-silence after the floor settles", async () => {
    const vad = new EnergyVad();
    const quiet = new Float32Array(FRAME).map(() => (Math.random() - 0.5) * 0.002);
    const loud = new Float32Array(FRAME).map((_, i) => 0.3 * Math.sin(i / 3));
    for (let i = 0; i < 30; i++) await vad.process(quiet);
    expect(await vad.process(quiet)).toBeLessThan(0.1);
    expect(await vad.process(loud)).toBeGreaterThan(0.9);
  });
});
