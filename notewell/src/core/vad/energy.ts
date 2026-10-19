import { dbfs } from "../audio/pcm.js";
import type { VoiceActivityDetector } from "./types.js";

export interface EnergyVadOptions {
  frameSize?: number;
  /** dB above the tracked noise floor that maps to probability 0.5. */
  marginDb?: number;
  /** Frames quieter than this are never speech. */
  absoluteFloorDb?: number;
}

/**
 * Dependency-free fallback VAD: compares frame loudness with an adaptive
 * noise floor. Good enough for clean audio and tests; Silero is far more
 * robust to music, typing and room noise.
 */
export class EnergyVad implements VoiceActivityDetector {
  readonly frameSize: number;
  private readonly marginDb: number;
  private readonly absoluteFloorDb: number;
  private noiseFloorDb = -60;

  constructor(options: EnergyVadOptions = {}) {
    this.frameSize = options.frameSize ?? 512;
    this.marginDb = options.marginDb ?? 12;
    this.absoluteFloorDb = options.absoluteFloorDb ?? -55;
  }

  async process(frame: Float32Array): Promise<number> {
    const level = dbfs(frame);
    // Fall quickly towards quieter levels, rise slowly, so speech does not
    // drag the floor up but a noisier room eventually does.
    const rate = level < this.noiseFloorDb ? 0.3 : 0.002;
    this.noiseFloorDb += (level - this.noiseFloorDb) * rate;
    if (level < this.absoluteFloorDb) return 0;
    const x = (level - (this.noiseFloorDb + this.marginDb)) / 3;
    return 1 / (1 + Math.exp(-x));
  }

  reset(): void {
    this.noiseFloorDb = -60;
  }
}
