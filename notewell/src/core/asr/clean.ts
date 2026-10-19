/**
 * Whisper was trained on subtitles, so on silence, music or noise it tends to
 * "hear" stock phrases. Utterances come from a VAD, which removes most of
 * that, but short noisy segments still slip through.
 */
const NON_SPEECH = /^[\s.]*[[(♪*][^\])]*[\])♪*]?[\s.]*$/u; // [BLANK_AUDIO], (music), ♪♪
const STOCK_PHRASES = new Set([
  "you",
  "thank you",
  "thank you.",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "thank you for watching.",
  "please subscribe",
  "bye",
  "bye.",
]);

export function cleanTranscriptText(raw: string, audioSeconds: number): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (NON_SPEECH.test(text)) return "";
  // Only distrust stock phrases on short clips; a real "thank you" at the end
  // of a long sentence-length utterance is kept.
  if (audioSeconds < 2.5 && STOCK_PHRASES.has(text.toLowerCase())) return "";
  if (isRepetitionLoop(text)) return "";
  // Fast speech is ~20 characters per second; far more text than the audio
  // could hold means the decoder ran away.
  if (audioSeconds > 0 && text.length > 12 && text.length / audioSeconds > MAX_CHARS_PER_SECOND) return "";
  return text;
}

const MAX_CHARS_PER_SECOND = 40;

/** Detects decoder loops such as "the the the the the …". */
function isRepetitionLoop(text: string): boolean {
  const words = text.toLowerCase().split(" ");
  if (words.length < 8) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / words.length > 0.6;
}
