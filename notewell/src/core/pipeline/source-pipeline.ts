import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Framer } from "../audio/framer.js";
import { StreamingResampler } from "../audio/resample.js";
import { cleanTranscriptText } from "../asr/clean.js";
import type { Transcriber } from "../asr/types.js";
import type { AudioSource, TranscriptSegment } from "../transcript/types.js";
import { UtteranceSegmenter, type SegmenterOptions } from "../vad/segmenter.js";
import { VAD_SAMPLE_RATE, type VoiceActivityDetector } from "../vad/types.js";

export interface SourcePipelineOptions {
  source: AudioSource;
  /** Sample rate of the audio passed to push(). */
  inputRate: number;
  vad: VoiceActivityDetector;
  transcriber: Transcriber;
  language?: string;
  segmenter?: Omit<SegmenterOptions, "sampleRate" | "frameSize">;
  /**
   * While someone is still talking, re-transcribe the open utterance this
   * often so text appears live. 0 disables interim results.
   */
  interimIntervalMs?: number;
}

export interface SourcePipelineEvents {
  segment: [TranscriptSegment];
  speech: [{ source: AudioSource; speaking: boolean }];
  error: [Error];
}

/**
 * One capture source (mic or system audio) from raw samples to transcript
 * segments: resample to 16 kHz → 32 ms frames → VAD → utterances → Whisper.
 *
 * VAD runs frame by frame in arrival order; transcription is fire-and-forget
 * into the transcriber's own queue so slow inference never stalls the VAD.
 */
export class SourcePipeline extends EventEmitter<SourcePipelineEvents> {
  readonly source: AudioSource;
  private readonly resampler: StreamingResampler;
  private readonly framer: Framer;
  private readonly segmenter: UtteranceSegmenter;
  private readonly interimSamples: number;
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private utteranceId: string | undefined;
  private lastInterimAt = 0;
  private interimInFlight = false;
  private stopped = false;

  constructor(private readonly options: SourcePipelineOptions) {
    super();
    this.source = options.source;
    this.resampler = new StreamingResampler(options.inputRate, VAD_SAMPLE_RATE);
    this.framer = new Framer(options.vad.frameSize);
    this.segmenter = new UtteranceSegmenter({
      sampleRate: VAD_SAMPLE_RATE,
      frameSize: options.vad.frameSize,
      ...options.segmenter,
    });
    this.interimSamples = Math.round(((options.interimIntervalMs ?? 2000) / 1000) * VAD_SAMPLE_RATE);
  }

  /** Queue captured samples (mono Float32 at inputRate). Never blocks. */
  push(samples: Float32Array): void {
    if (this.stopped) return;
    const resampled = this.resampler.push(samples);
    const frames = this.framer.push(resampled);
    if (frames.length) this.enqueue(frames);
  }

  /** Flush buffered audio and wait for every pending transcription. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const tail = this.resampler.flush();
    const frames = this.framer.push(tail);
    const last = this.framer.flush();
    if (last) frames.push(last);
    this.enqueue(frames);
    await this.chain;
    this.handle(this.segmenter.flush());
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private enqueue(frames: Float32Array[]): void {
    this.chain = this.chain
      .then(async () => {
        for (const frame of frames) {
          const probability = await this.options.vad.process(frame);
          this.handle(this.segmenter.push(frame, probability));
        }
        this.maybeInterim();
      })
      .catch((err: unknown) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
  }

  private handle(events: ReturnType<UtteranceSegmenter["push"]>): void {
    for (const event of events) {
      if (event.type === "speech-start") {
        this.utteranceId = randomUUID();
        this.lastInterimAt = 0;
        this.emit("speech", { source: this.source, speaking: true });
        continue;
      }
      const id = this.utteranceId ?? randomUUID();
      this.utteranceId = this.segmenter.isSpeaking ? randomUUID() : undefined; // max-length cut keeps speaking
      this.lastInterimAt = 0;
      if (!this.segmenter.isSpeaking) this.emit("speech", { source: this.source, speaking: false });
      this.track(this.transcribe(id, event.startSample, event.endSample, event.audio, true));
    }
  }

  private maybeInterim(): void {
    if (this.interimSamples <= 0 || this.interimInFlight || !this.utteranceId) return;
    const active = this.segmenter.activeUtterance();
    if (!active || active.audio.length - this.lastInterimAt < this.interimSamples) return;
    this.lastInterimAt = active.audio.length;
    this.interimInFlight = true;
    const id = this.utteranceId;
    const end = active.startSample + active.audio.length;
    this.track(
      this.transcribe(id, active.startSample, end, active.audio, false).finally(() => {
        this.interimInFlight = false;
      }),
    );
  }

  private async transcribe(id: string, start: number, end: number, audio: Float32Array, final: boolean): Promise<void> {
    try {
      const { text } = await this.options.transcriber.transcribe(audio, {
        ...(this.options.language ? { language: this.options.language } : {}),
      });
      const clean = cleanTranscriptText(text, audio.length / VAD_SAMPLE_RATE);
      if (!final && !clean) return;
      this.emit("segment", {
        id,
        source: this.source,
        startMs: Math.round((start / VAD_SAMPLE_RATE) * 1000),
        endMs: Math.round((end / VAD_SAMPLE_RATE) * 1000),
        text: clean,
        final,
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}
