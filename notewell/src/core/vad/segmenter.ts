import { concatFloat32 } from "../audio/pcm.js";

export interface SegmenterOptions {
  sampleRate: number;
  frameSize: number;
  /** Probability that opens an utterance. */
  startThreshold?: number;
  /** Probability below which a frame counts as silence (hysteresis). */
  endThreshold?: number;
  /** Utterances with less speech than this are discarded as blips. */
  minSpeechMs?: number;
  /** Trailing silence that closes an utterance. */
  minSilenceMs?: number;
  /** Audio kept from before the start trigger so first syllables survive. */
  preRollMs?: number;
  /** Silence kept after the last speech frame. */
  postRollMs?: number;
  /** Long monologues are cut so transcripts appear while someone keeps talking. */
  maxUtteranceMs?: number;
}

export type SegmentEvent =
  | { type: "speech-start"; startSample: number }
  | {
      type: "utterance";
      startSample: number;
      endSample: number;
      audio: Float32Array;
      reason: "silence" | "max-length" | "flush";
    };

/**
 * Turns per-frame speech probabilities into utterances. Pure and synchronous:
 * the caller runs the VAD model and feeds frames with their probabilities, so
 * this state machine is testable without any model.
 */
export class UtteranceSegmenter {
  private readonly frameMs: number;
  private readonly startThreshold: number;
  private readonly endThreshold: number;
  private readonly minSpeechFrames: number;
  private readonly minSilenceFrames: number;
  private readonly preRollFrames: number;
  private readonly postRollFrames: number;
  private readonly maxFrames: number;

  private cursor = 0; // absolute sample index of the next frame
  private preRoll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private speaking = false;
  private utteranceStart = 0;
  private speechFrames = 0;
  private silenceRun = 0;

  constructor(readonly options: SegmenterOptions) {
    this.frameMs = (options.frameSize / options.sampleRate) * 1000;
    const frames = (ms: number) => Math.max(0, Math.round(ms / this.frameMs));
    this.startThreshold = options.startThreshold ?? 0.5;
    this.endThreshold = options.endThreshold ?? 0.35;
    this.minSpeechFrames = Math.max(1, frames(options.minSpeechMs ?? 250));
    this.minSilenceFrames = Math.max(1, frames(options.minSilenceMs ?? 600));
    this.preRollFrames = frames(options.preRollMs ?? 300);
    this.postRollFrames = frames(options.postRollMs ?? 200);
    this.maxFrames = Math.max(this.minSpeechFrames + 1, frames(options.maxUtteranceMs ?? 15000));
  }

  /** True while an utterance is open. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Snapshot of the open utterance, used for interim transcripts. */
  activeUtterance(): { startSample: number; audio: Float32Array } | undefined {
    if (!this.speaking) return undefined;
    return { startSample: this.utteranceStart, audio: concatFloat32(this.frames) };
  }

  push(frame: Float32Array, probability: number): SegmentEvent[] {
    if (frame.length !== this.options.frameSize) throw new RangeError("frame size mismatch");
    const events: SegmentEvent[] = [];
    const frameStart = this.cursor;
    this.cursor += frame.length;

    if (!this.speaking) {
      if (probability >= this.startThreshold) {
        this.speaking = true;
        this.frames = [...this.preRoll, frame];
        this.utteranceStart = frameStart - this.preRoll.length * this.options.frameSize;
        this.preRoll = [];
        this.speechFrames = 1;
        this.silenceRun = 0;
        events.push({ type: "speech-start", startSample: this.utteranceStart });
      } else {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      }
      return events;
    }

    this.frames.push(frame);
    if (probability < this.endThreshold) {
      this.silenceRun++;
    } else {
      this.silenceRun = 0;
      this.speechFrames++;
    }

    if (this.silenceRun >= this.minSilenceFrames) {
      const trim = Math.max(0, this.silenceRun - this.postRollFrames);
      const event = this.close("silence", trim);
      if (event) events.push(event);
      // The trimmed silence becomes pre-roll for whatever comes next.
      return events;
    }

    if (this.frames.length >= this.maxFrames) {
      const event = this.close("max-length", 0);
      if (event) events.push(event);
      // Keep listening: the speaker has not stopped, open a fresh utterance.
      this.speaking = true;
      this.frames = [];
      this.utteranceStart = this.cursor;
      this.speechFrames = 0;
      this.silenceRun = 0;
    }
    return events;
  }

  /** Close any open utterance (end of meeting / source stopped). */
  flush(): SegmentEvent[] {
    if (!this.speaking) return [];
    const event = this.close("flush", Math.max(0, this.silenceRun - this.postRollFrames));
    return event ? [event] : [];
  }

  private close(reason: "silence" | "max-length" | "flush", trimFrames: number): SegmentEvent | undefined {
    const kept = this.frames.slice(0, this.frames.length - trimFrames);
    const trimmed = this.frames.slice(this.frames.length - trimFrames);
    const enough = this.speechFrames >= this.minSpeechFrames;
    const start = this.utteranceStart;
    this.speaking = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.preRoll = this.preRollFrames > 0 ? trimmed.slice(-this.preRollFrames) : [];
    if (!enough || kept.length === 0) return undefined;
    const audio = concatFloat32(kept);
    return { type: "utterance", startSample: start, endSample: start + audio.length, audio, reason };
  }
}
