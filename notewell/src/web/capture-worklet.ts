/**
 * AudioWorklet processor: converts the capture stream to mono PCM16 and posts
 * ~100 ms batches to the main thread. Runs on the audio rendering thread.
 */

// AudioWorkletGlobalScope is not part of lib.dom; declare what we use.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  // Kept separately: transferring a batch detaches it, so batch.length reads 0.
  private readonly batchSize = Math.round(sampleRate / 10);
  private batch = new Int16Array(this.batchSize);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0]!.length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i]!;
      const s = Math.max(-1, Math.min(1, sum / channels.length));
      this.batch[this.filled++] = s < 0 ? s * 32768 : s * 32767;
      if (this.filled === this.batchSize) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Int16Array(this.batchSize);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
