import type { Transcriber } from "../core/asr/types.js";
import { WhisperTranscriber } from "../core/asr/whisper.js";
import { EnergyVad } from "../core/vad/energy.js";
import { SileroVad } from "../core/vad/silero.js";
import type { VoiceActivityDetector } from "../core/vad/types.js";

export interface EngineOptions {
  whisperModel?: string;
  language?: string;
  /** Force the dependency-free energy VAD (tests, constrained machines). */
  energyVad?: boolean;
  /** Injected transcriber for tests. */
  transcriber?: Transcriber;
}

/**
 * Owns the expensive, shareable model state. Whisper is loaded once and
 * shared by every source (its queue serialises inference); VADs are cheap and
 * stateful, so each source gets its own.
 */
export class Engine {
  private transcriberPromise: Promise<Transcriber> | undefined;
  private sileroAvailable: boolean | undefined;

  constructor(private readonly options: EngineOptions = {}) {}

  get language(): string | undefined {
    return this.options.language;
  }

  transcriber(): Promise<Transcriber> {
    if (this.options.transcriber) return Promise.resolve(this.options.transcriber);
    this.transcriberPromise ??= WhisperTranscriber.load({
      ...(this.options.whisperModel ? { model: this.options.whisperModel } : {}),
      ...(this.options.language ? { language: this.options.language } : {}),
    }).catch((err: unknown) => {
      this.transcriberPromise = undefined; // allow a retry after e.g. a network error
      throw err;
    });
    return this.transcriberPromise;
  }

  async createVad(): Promise<{ vad: VoiceActivityDetector; name: string }> {
    if (this.options.energyVad || this.sileroAvailable === false) return { vad: new EnergyVad(), name: "energy" };
    try {
      const vad = await SileroVad.load();
      this.sileroAvailable = true;
      return { vad, name: "silero-v5" };
    } catch (err) {
      this.sileroAvailable = false;
      console.warn(`Silero VAD unavailable, falling back to energy VAD: ${(err as Error).message}`);
      return { vad: new EnergyVad(), name: "energy" };
    }
  }

  /** Download/load models ahead of the first meeting. */
  async warmUp(): Promise<void> {
    await Promise.all([this.transcriber(), this.createVad()]);
  }
}
