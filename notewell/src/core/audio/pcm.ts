/** Sample-format helpers. All internal audio is mono Float32 in [-1, 1]. */

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 32768;
  return out;
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

/** Average all channels into one. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i]! += channel[i]!;
  }
  for (let i = 0; i < length; i++) out[i]! /= channels.length;
  return out;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** RMS level in dB relative to full scale; silence floors at -100 dBFS. */
export function dbfs(samples: Float32Array): number {
  const level = rms(samples);
  return level > 1e-5 ? 20 * Math.log10(level) : -100;
}

export function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
