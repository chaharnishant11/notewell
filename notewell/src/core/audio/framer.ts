/** Re-chunks a stream of arbitrarily sized buffers into fixed-size frames. */
export class Framer {
  private pending = new Float32Array(0);

  constructor(readonly frameSize: number) {
    if (!Number.isInteger(frameSize) || frameSize <= 0) throw new RangeError("frameSize must be a positive integer");
  }

  push(samples: Float32Array): Float32Array[] {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const frames: Float32Array[] = [];
    let offset = 0;
    for (; offset + this.frameSize <= joined.length; offset += this.frameSize) {
      frames.push(joined.slice(offset, offset + this.frameSize));
    }
    this.pending = joined.slice(offset);
    return frames;
  }

  /** Zero-pad and return the remaining partial frame, if any. */
  flush(): Float32Array | undefined {
    if (this.pending.length === 0) return undefined;
    const frame = new Float32Array(this.frameSize);
    frame.set(this.pending);
    this.pending = new Float32Array(0);
    return frame;
  }
}
