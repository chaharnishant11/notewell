/**
 * Where audio came from. Like Granola, speaker attribution starts from the
 * capture path: the microphone is the local user ("me"), system output is
 * everyone else on the call ("them").
 */
export type AudioSource = "microphone" | "system";

export interface TranscriptSegment {
  /** Stable per utterance: interim updates and the final text share it. */
  id: string;
  source: AudioSource;
  /** Milliseconds since the meeting started. */
  startMs: number;
  endMs: number;
  text: string;
  /** Interim segments may still change; final ones never do. */
  final: boolean;
}

export const SPEAKER_LABEL: Record<AudioSource, string> = {
  microphone: "Me",
  system: "Them",
};
