#!/usr/bin/env node
/**
 * notewell CLI
 *   notewell [serve] [server options]      start the local app (default)
 *   notewell transcribe <file.wav> [--language en] [--json]
 *   notewell enhance <file.wav> [--notes notes.md] [--template general]
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { downmix } from "./core/audio/pcm.js";
import { resample } from "./core/audio/resample.js";
import { decodeWav } from "./core/audio/wav.js";
import { cleanTranscriptText } from "./core/asr/clean.js";
import { WhisperTranscriber } from "./core/asr/whisper.js";
import { createEnhancer } from "./core/enhance/enhancer.js";
import { OpenAIProvider } from "./core/llm/openai.js";
import type { Meeting } from "./core/store/meetings.js";
import { TranscriptStore } from "./core/transcript/store.js";
import type { TranscriptSegment } from "./core/transcript/types.js";
import { UtteranceSegmenter } from "./core/vad/segmenter.js";
import { SileroVad } from "./core/vad/silero.js";

const [command = "serve", ...rest] = process.argv.slice(2);

async function transcribeFile(path: string, language?: string): Promise<TranscriptSegment[]> {
  const decoded = decodeWav(new Uint8Array(await readFile(path)));
  const audio = resample(downmix(decoded.channels), decoded.sampleRate, 16000);
  const [vad, whisper] = await Promise.all([SileroVad.load(), WhisperTranscriber.load(language ? { language } : {})]);
  const segmenter = new UtteranceSegmenter({ sampleRate: 16000, frameSize: vad.frameSize });
  const segments: TranscriptSegment[] = [];
  const handle = async (events: ReturnType<UtteranceSegmenter["push"]>) => {
    for (const e of events) {
      if (e.type !== "utterance") continue;
      const { text } = await whisper.transcribe(e.audio);
      const clean = cleanTranscriptText(text, e.audio.length / 16000);
      if (!clean) continue;
      const segment: TranscriptSegment = {
        id: String(segments.length + 1),
        source: "system",
        startMs: Math.round(e.startSample / 16),
        endMs: Math.round(e.endSample / 16),
        text: clean,
        final: true,
      };
      segments.push(segment);
      process.stderr.write(`  [${(segment.startMs / 1000).toFixed(1)}s] ${clean}\n`);
    }
  };
  for (let i = 0; i + vad.frameSize <= audio.length; i += vad.frameSize) {
    const frame = audio.subarray(i, i + vad.frameSize);
    await handle(segmenter.push(frame, await vad.process(frame)));
  }
  await handle(segmenter.flush());
  return segments;
}

async function main(): Promise<void> {
  if (command === "serve" || command.startsWith("-")) {
    // The server parses process.argv itself; drop the subcommand word.
    if (command === "serve") process.argv.splice(2, 1);
    await import("./server/main.js");
    return;
  }

  if (command === "transcribe" || command === "enhance") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        language: { type: "string" },
        json: { type: "boolean", default: false },
        notes: { type: "string" },
        template: { type: "string", default: "general" },
        title: { type: "string", default: "Recorded meeting" },
      },
    });
    const file = positionals[0];
    if (!file) throw new Error(`usage: notewell ${command} <file.wav>`);
    const segments = await transcribeFile(file, values.language);
    if (command === "transcribe") {
      console.log(values.json ? JSON.stringify(segments, null, 2) : new TranscriptStore(segments).toText({ timestamps: true }));
      return;
    }
    const meeting: Meeting = {
      id: "00000000-0000-0000-0000-000000000000",
      title: values.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      context: "",
      notes: values.notes ? await readFile(values.notes, "utf8") : "",
      transcript: segments,
      enhanced: null,
    };
    const enhancer = createEnhancer(new OpenAIProvider());
    await enhancer.enhance({ meeting, templateId: values.template }, (delta) => process.stdout.write(delta));
    process.stdout.write("\n");
    return;
  }

  console.error(`unknown command "${command}". Commands: serve, transcribe, enhance`);
  process.exit(2);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
