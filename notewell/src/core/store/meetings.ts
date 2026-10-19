import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptSegment } from "../transcript/types.js";

export interface EnhancedNotes {
  templateId: string;
  markdown: string;
  model: string;
  createdAt: string;
}

export interface Meeting {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Free-form context such as attendees or the agenda, fed to enhancement. */
  context: string;
  /** The user's own notes, as Markdown. Never overwritten by AI output. */
  notes: string;
  transcript: TranscriptSegment[];
  enhanced: EnhancedNotes | null;
}

export type MeetingSummary = Pick<Meeting, "id" | "title" | "createdAt" | "updatedAt"> & {
  hasEnhanced: boolean;
  segmentCount: number;
};

export function defaultDataDir(): string {
  return process.env.NOTEWELL_DATA_DIR ?? join(homedir(), ".notewell");
}

const ID_PATTERN = /^[0-9a-f-]{36}$/;

/** One JSON file per meeting; writes are atomic and serialised per meeting. */
export class MeetingStore {
  private readonly dir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dataDir: string = defaultDataDir()) {
    this.dir = join(dataDir, "meetings");
  }

  async create(input: { title?: string; context?: string } = {}): Promise<Meeting> {
    const now = new Date().toISOString();
    const meeting: Meeting = {
      id: randomUUID(),
      title: input.title?.trim() || `Meeting ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      createdAt: now,
      updatedAt: now,
      context: input.context ?? "",
      notes: "",
      transcript: [],
      enhanced: null,
    };
    await this.save(meeting);
    return meeting;
  }

  async get(id: string): Promise<Meeting | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Meeting;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async list(): Promise<MeetingSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const meetings = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => this.get(f.slice(0, -5)).catch(() => undefined)),
    );
    return meetings
      .filter((m): m is Meeting => m !== undefined)
      .map((m) => ({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        hasEnhanced: m.enhanced !== null,
        segmentCount: m.transcript.length,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Read-modify-write under the per-meeting lock. */
  async update(id: string, change: (meeting: Meeting) => void): Promise<Meeting | undefined> {
    let result: Meeting | undefined;
    await this.locked(id, async () => {
      const meeting = await this.get(id);
      if (!meeting) return;
      change(meeting);
      meeting.updatedAt = new Date().toISOString();
      await this.write(meeting);
      result = meeting;
    });
    return result;
  }

  async delete(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    let existed = false;
    await this.locked(id, async () => {
      existed = (await this.get(id)) !== undefined;
      await rm(this.path(id), { force: true });
    });
    return existed;
  }

  private async save(meeting: Meeting): Promise<void> {
    await this.locked(meeting.id, () => this.write(meeting));
  }

  private async write(meeting: Meeting): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(meeting.id);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temp, JSON.stringify(meeting, null, 2));
    await rename(temp, target);
  }

  private locked(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.writes.set(id, settled);
    void settled.then(() => {
      if (this.writes.get(id) === settled) this.writes.delete(id);
    });
    return next;
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
