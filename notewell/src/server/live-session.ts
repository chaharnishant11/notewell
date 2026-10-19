import type { WebSocket } from "ws";
import { int16ToFloat32 } from "../core/audio/pcm.js";
import { SourcePipeline } from "../core/pipeline/source-pipeline.js";
import type { MeetingStore } from "../core/store/meetings.js";
import { TranscriptStore } from "../core/transcript/store.js";
import type { TranscriptSegment } from "../core/transcript/types.js";
import { decodeAudioFrame, type ClientMessage, type ServerMessage, type Source } from "../shared/protocol.js";
import type { Engine } from "./engine.js";

/** Gap inserted between recording sessions when a meeting is resumed. */
const RESUME_GAP_MS = 1000;
const MAX_SAMPLE_RATE = 192000;
/** Audio kept per source while models load on first use. */
const MAX_BUFFERED_SECONDS = 120;

/**
 * One recording connection for one meeting. Mirrors the role of Granola's
 * main process: it owns the audio pipelines, merges both sources into a
 * single transcript, persists final segments and pushes updates to the UI.
 */
export class LiveSession {
  private pipelines = new Map<Source, SourcePipeline>();
  private transcript: TranscriptStore | undefined;
  private offsetMs = 0;
  private persistTimer: NodeJS.Timeout | undefined;
  private starting: Promise<void> | undefined;
  /** Frames that arrive while pipelines are still being created. */
  private buffered: { source: Source; samples: Float32Array }[] | undefined;
  private bufferedSamples = new Map<Source, number>();
  private bufferLimit = new Map<Source, number>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly meetingId: string,
    private readonly engine: Engine,
    private readonly meetings: MeetingStore,
  ) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.onAudio(toUint8(data));
      else this.onControl(String(data));
    });
    socket.on("close", () => {
      this.closed = true;
      void this.stop();
    });
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onControl(raw: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.send({ type: "error", message: "invalid JSON control message" });
    }
    if (message.type === "start") {
      if (this.buffered || this.pipelines.size) {
        return this.send({ type: "error", message: "already recording" });
      }
      // Buffer audio from now on: loading Whisper can take a while the first time.
      this.buffered = [];
      this.bufferedSamples.clear();
      this.bufferLimit.clear();
      for (const [source, rate] of Object.entries(message.sampleRates ?? {})) {
        if (typeof rate === "number") this.bufferLimit.set(source as Source, rate * MAX_BUFFERED_SECONDS);
      }
      this.starting = this.start(message.sampleRates)
        .catch((err: Error) => {
          this.send({ type: "error", message: `could not start transcription: ${err.message}` });
        })
        .finally(() => {
          this.buffered = undefined;
        });
    } else if (message.type === "stop") {
      void this.stop().then(() => this.send({ type: "stopped" }));
    }
  }

  private async start(sampleRates: Partial<Record<Source, number>>): Promise<void> {
    if (this.pipelines.size) throw new Error("already recording");
    const meeting = await this.meetings.get(this.meetingId);
    if (!meeting) throw new Error("meeting not found");
    this.transcript = new TranscriptStore(meeting.transcript);
    const lastEnd = meeting.transcript.reduce((max, s) => Math.max(max, s.endMs), 0);
    this.offsetMs = lastEnd > 0 ? lastEnd + RESUME_GAP_MS : 0;

    const transcriber = await this.engine.transcriber();
    let vadName = "none";
    for (const [source, rate] of Object.entries(sampleRates) as [Source, number][]) {
      if (!Number.isFinite(rate) || rate < 8000 || rate > MAX_SAMPLE_RATE) {
        throw new Error(`unsupported sample rate ${rate} for ${source}`);
      }
      const { vad, name } = await this.engine.createVad();
      vadName = name;
      const pipeline = new SourcePipeline({
        source,
        inputRate: rate,
        vad,
        transcriber,
        ...(this.engine.language ? { language: this.engine.language } : {}),
      });
      pipeline.on("segment", (s) => this.onSegment(s));
      pipeline.on("speech", (e) => this.send({ type: "speech", ...e }));
      pipeline.on("error", (err) => this.send({ type: "error", message: err.message }));
      this.pipelines.set(source, pipeline);
    }
    // Replay what arrived during model loading, in order, then go live.
    const pending = this.buffered ?? [];
    this.buffered = undefined;
    for (const { source, samples } of pending) this.pipelines.get(source)?.push(samples);
    if (this.closed) return void (await this.stop());
    this.send({ type: "ready", asr: transcriber.name, vad: vadName });
  }

  private onAudio(data: Uint8Array): void {
    const frame = decodeAudioFrame(data);
    if (!frame) return;
    const samples = int16ToFloat32(frame.pcm);
    if (this.buffered) {
      const used = this.bufferedSamples.get(frame.source) ?? 0;
      if (used + samples.length <= (this.bufferLimit.get(frame.source) ?? 0)) {
        this.buffered.push({ source: frame.source, samples });
        this.bufferedSamples.set(frame.source, used + samples.length);
      }
      return;
    }
    this.pipelines.get(frame.source)?.push(samples);
  }

  private onSegment(segment: TranscriptSegment): void {
    const shifted = { ...segment, startMs: segment.startMs + this.offsetMs, endMs: segment.endMs + this.offsetMs };
    if (!this.transcript?.upsert(shifted)) return;
    this.send({ type: "segment", segment: shifted });
    if (shifted.final) this.schedulePersist();
  }

  private schedulePersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), 1000);
  }

  private async persist(): Promise<void> {
    clearTimeout(this.persistTimer);
    const finals = this.transcript?.segments({ finalOnly: true });
    if (!finals) return;
    await this.meetings.update(this.meetingId, (m) => {
      m.transcript = finals;
    });
  }

  async stop(): Promise<void> {
    await this.starting;
    const pipelines = [...this.pipelines.values()];
    this.pipelines.clear();
    await Promise.all(pipelines.map((p) => p.stop()));
    if (pipelines.length) await this.persist();
  }
}

function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array(0);
}
