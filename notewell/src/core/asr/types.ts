export interface TranscribeOptions {
  /** ISO-639-1 code such as "en" or "de"; undefined lets the model decide. */
  language?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  /** Wall time spent inside the model, for latency metrics. */
  inferenceMs: number;
}

/** Turns one utterance of 16 kHz mono audio into text. */
export interface Transcriber {
  readonly name: string;
  transcribe(audio: Float32Array, options?: TranscribeOptions): Promise<TranscriptionResult>;
}
