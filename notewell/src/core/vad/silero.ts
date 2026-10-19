import { resolveModelFile, type ModelFileOptions } from "../models.js";
import { VAD_SAMPLE_RATE, type VoiceActivityDetector } from "./types.js";

// onnxruntime-node is a dependency of @huggingface/transformers; import it
// lazily so the energy VAD and tests never load the native binding.
type Ort = typeof import("onnxruntime-node");

const FRAME_SIZE = 512; // 32 ms at 16 kHz, the window Silero v5 is trained on
const CONTEXT_SIZE = 64; // v5 expects the previous 64 samples prepended

/** Silero VAD v5 (MIT) running locally through ONNX Runtime. */
export class SileroVad implements VoiceActivityDetector {
  readonly frameSize = FRAME_SIZE;
  private state: Float32Array = new Float32Array(2 * 128);
  private context = new Float32Array(CONTEXT_SIZE);
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly ort: Ort,
    private readonly session: import("onnxruntime-node").InferenceSession,
  ) {}

  static async load(options: ModelFileOptions & { repo?: string; file?: string } = {}): Promise<SileroVad> {
    const ort = await import("onnxruntime-node");
    const path = await resolveModelFile(options.repo ?? "onnx-community/silero-vad", options.file ?? "onnx/model.onnx", options);
    const session = await ort.InferenceSession.create(path, { intraOpNumThreads: 1, interOpNumThreads: 1 });
    return new SileroVad(ort, session);
  }

  process(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SIZE) throw new RangeError(`Silero expects ${FRAME_SIZE}-sample frames`);
    // The recurrent state makes calls order-dependent, so serialise them.
    const result = this.queue.then(() => this.run(frame));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(frame: Float32Array): Promise<number> {
    const { Tensor } = this.ort;
    const input = new Float32Array(CONTEXT_SIZE + FRAME_SIZE);
    input.set(this.context);
    input.set(frame, CONTEXT_SIZE);
    const outputs = await this.session.run({
      input: new Tensor("float32", input, [1, input.length]),
      state: new Tensor("float32", this.state, [2, 1, 128]),
      sr: new Tensor("int64", BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), []),
    });
    this.state = Float32Array.from(outputs.stateN!.data as Float32Array);
    this.context = frame.slice(FRAME_SIZE - CONTEXT_SIZE);
    return (outputs.output!.data as Float32Array)[0]!;
  }

  reset(): void {
    this.state = new Float32Array(2 * 128);
    this.context = new Float32Array(CONTEXT_SIZE);
  }
}
