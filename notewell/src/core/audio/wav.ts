/** Minimal RIFF/WAVE codec: integer PCM (8/16/24/32-bit) and 32-bit float. */

export interface DecodedAudio {
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let format: number | undefined;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: { offset: number; length: number } | undefined;

  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) {
        // The first two bytes of the SubFormat GUID carry the real format code.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      data = { offset: body, length: Math.min(size, bytes.length - body) };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (format === undefined || !data) throw new Error("WAV is missing fmt or data chunk");
  if (channelCount < 1) throw new Error("WAV declares no channels");

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(data.length / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  const read = sampleReader(view, format, bitsPerSample);

  for (let frame = 0; frame < frameCount; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const at = data.offset + (frame * channelCount + c) * bytesPerSample;
      channels[c]![frame] = read(at);
    }
  }
  return { sampleRate, channels };
}

function sampleReader(view: DataView, format: number, bits: number): (at: number) => number {
  if (format === WAVE_FORMAT_IEEE_FLOAT && bits === 32) return (at) => view.getFloat32(at, true);
  if (format !== WAVE_FORMAT_PCM) throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
  switch (bits) {
    case 8:
      return (at) => (view.getUint8(at) - 128) / 128;
    case 16:
      return (at) => view.getInt16(at, true) / 32768;
    case 24:
      return (at) => {
        const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        return v / 8388608;
      };
    case 32:
      return (at) => view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`unsupported PCM bit depth ${bits}`);
  }
}

/** Encode mono Float32 samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLength = samples.length * 2;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return out;
}
