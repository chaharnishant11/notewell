/**
 * Wire protocol between the browser and the local server.
 *
 * Audio travels as binary WebSocket messages:
 *   byte 0      source tag (0 = microphone, 1 = system)
 *   bytes 1..n  little-endian PCM16 mono at the rate announced in "start"
 * The browser sends its native capture rate; the server resamples to 16 kHz.
 * Everything else is JSON text.
 */
export type Source = "microphone" | "system";
export const SOURCE_TAG: Record<Source, number> = { microphone: 0, system: 1 };
export const TAG_SOURCE: readonly Source[] = ["microphone", "system"];

export interface Segment {
  id: string;
  source: Source;
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

export type ClientMessage =
  /** Announces which sources will stream and at what sample rate. */
  | { type: "start"; sampleRates: Partial<Record<Source, number>> }
  | { type: "stop" };

export type ServerMessage =
  | { type: "ready"; asr: string; vad: string }
  | { type: "segment"; segment: Segment }
  | { type: "speech"; source: Source; speaking: boolean }
  | { type: "stopped" }
  | { type: "error"; message: string };

export function encodeAudioFrame(source: Source, pcm: Int16Array): ArrayBuffer {
  const out = new Uint8Array(1 + pcm.byteLength);
  out[0] = SOURCE_TAG[source];
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  return out.buffer;
}

export function decodeAudioFrame(data: Uint8Array): { source: Source; pcm: Int16Array } | undefined {
  const source = TAG_SOURCE[data[0] ?? -1];
  if (!source || data.length < 3 || (data.length - 1) % 2 !== 0) return undefined;
  // Copy into a fresh buffer so the Int16Array is 2-byte aligned. (Node's
  // Buffer.slice returns a view, so slice() alone is not enough.)
  const bytes = new Uint8Array(data.length - 1);
  bytes.set(data.subarray(1));
  return { source, pcm: new Int16Array(bytes.buffer) };
}
