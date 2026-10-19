/**
 * Live end-to-end check with real models (downloads ~85 MB on first run):
 *   npm run test:live
 * Decodes a public-domain speech sample, runs Silero VAD + segmentation, then
 * local Whisper on each utterance.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { downmix } from "../audio/pcm.js";
import { resample } from "../audio/resample.js";
import { decodeWav } from "../audio/wav.js";
import { resolveModelFile } from "../models.js";
import { UtteranceSegmenter } from "../vad/segmenter.js";
import { SileroVad } from "../vad/silero.js";
import { cleanTranscriptText } from "./clean.js";
import { WhisperTranscriber } from "./whisper.js";

describe("local transcription (live models)", () => {
  it("transcribes the JFK inaugural sample", { timeout: 600_000 }, async () => {
    const wavPath = await resolveModelFile("datasets/Xenova/transformers.js-docs", "jfk.wav");
    const decoded = decodeWav(new Uint8Array(await readFile(wavPath)));
    const audio = resample(downmix(decoded.channels), decoded.sampleRate, 16000);

    const vad = await SileroVad.load();
    const segmenter = new UtteranceSegmenter({ sampleRate: 16000, frameSize: vad.frameSize });
    const utterances = [];
    for (let i = 0; i + vad.frameSize <= audio.length; i += vad.frameSize) {
      const frame = audio.subarray(i, i + vad.frameSize);
      for (const e of segmenter.push(frame, await vad.process(frame))) if (e.type === "utterance") utterances.push(e);
    }
    for (const e of segmenter.flush()) if (e.type === "utterance") utterances.push(e);
    expect(utterances.length).toBeGreaterThan(0);

    const whisper = await WhisperTranscriber.load({ language: "en" });
    const lines: string[] = [];
    for (const u of utterances) {
      const { text, inferenceMs } = await whisper.transcribe(u.audio);
      const clean = cleanTranscriptText(text, u.audio.length / 16000);
      const at = (s: number) => (s / 16000).toFixed(1).padStart(5);
      console.log(`[${at(u.startSample)}s-${at(u.endSample)}s] (${inferenceMs.toFixed(0)} ms) ${clean}`);
      if (clean) lines.push(clean);
    }
    const transcript = lines
      .join(" ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ");
    expect(transcript).toContain("ask not what your country can do for you");
  });
});
