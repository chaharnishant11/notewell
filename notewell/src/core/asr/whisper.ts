import { defaultModelDir } from "../models.js";
import type { TranscribeOptions, TranscriptionResult, Transcriber } from "./types.js";

export interface WhisperOptions {
  /** Any transformers.js Whisper export, e.g. onnx-community/whisper-small. */
  model?: string;
  /** Weight precision; q8 keeps whisper-base around 80 MB and fast on CPU. */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  cacheDir?: string;
  /** Default language for every call; overridable per call. */
  language?: string;
}

type AsrPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

/**
 * Local Whisper through transformers.js (ONNX Runtime). Calls are serialised:
 * one inference at a time keeps memory flat and preserves utterance order.
 */
export class WhisperTranscriber implements Transcriber {
  readonly name: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly asr: AsrPipeline,
    readonly model: string,
    private readonly language: string | undefined,
  ) {
    this.name = `whisper:${model}`;
  }

  static async load(options: WhisperOptions = {}): Promise<WhisperTranscriber> {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = options.cacheDir ?? defaultModelDir();
    const model = options.model ?? process.env.NOTEWELL_WHISPER_MODEL ?? "onnx-community/whisper-base";
    const asr = (await pipeline("automatic-speech-recognition", model, {
      dtype: options.dtype ?? "q8",
    })) as unknown as AsrPipeline;
    return new WhisperTranscriber(asr, model, options.language ?? process.env.NOTEWELL_LANGUAGE);
  }

  transcribe(audio: Float32Array, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const run = this.queue.then(async () => {
      options.signal?.throwIfAborted();
      const language = options.language ?? this.language;
      const started = performance.now();
      const output = await this.asr(audio, {
        task: "transcribe",
        ...(language ? { language } : {}),
        // Utterances are VAD-bounded (<= ~15 s); longer input is chunked.
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const first = Array.isArray(output) ? output[0] : output;
      return { text: first?.text ?? "", inferenceMs: performance.now() - started };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
