/** Frame-level voice activity detection on 16 kHz mono audio. */
export interface VoiceActivityDetector {
  /** Samples per frame the detector expects. */
  readonly frameSize: number;
  /** Probability in [0, 1] that the frame contains speech. */
  process(frame: Float32Array): Promise<number>;
  reset(): void;
}

export const VAD_SAMPLE_RATE = 16000;
