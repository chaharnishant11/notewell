import { SPEAKER_LABEL, type TranscriptSegment } from "./types.js";

/**
 * Holds a meeting's transcript. Interim segments are replaced in place when a
 * newer version (same id) arrives; the transcript is always ordered by start.
 */
export class TranscriptStore {
  private readonly byId = new Map<string, TranscriptSegment>();

  constructor(initial: readonly TranscriptSegment[] = []) {
    for (const s of initial) this.byId.set(s.id, s);
  }

  /** Insert or update; returns false if a final segment would be downgraded. */
  upsert(segment: TranscriptSegment): boolean {
    const existing = this.byId.get(segment.id);
    if (existing?.final && !segment.final) return false;
    if (segment.final && !segment.text) {
      this.byId.delete(segment.id); // utterance turned out to be non-speech
      return true;
    }
    this.byId.set(segment.id, segment);
    return true;
  }

  get(id: string): TranscriptSegment | undefined {
    return this.byId.get(id);
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  segments(options: { finalOnly?: boolean } = {}): TranscriptSegment[] {
    const all = [...this.byId.values()].filter((s) => !options.finalOnly || s.final);
    return all.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  }

  /**
   * Speaker-labelled plain text for prompts and export. Consecutive segments
   * from the same source are merged into one turn.
   */
  toText(options: { timestamps?: boolean } = {}): string {
    const turns: { source: TranscriptSegment["source"]; startMs: number; parts: string[] }[] = [];
    for (const s of this.segments({ finalOnly: true })) {
      const last = turns.at(-1);
      if (last && last.source === s.source) last.parts.push(s.text);
      else turns.push({ source: s.source, startMs: s.startMs, parts: [s.text] });
    }
    return turns
      .map((t) => {
        const stamp = options.timestamps ? `[${formatClock(t.startMs)}] ` : "";
        return `${stamp}${SPEAKER_LABEL[t.source]}: ${t.parts.join(" ")}`;
      })
      .join("\n");
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
