import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeetingStore } from "./meetings.js";

describe("MeetingStore", () => {
  let dir: string;
  let store: MeetingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "notewell-store-"));
    store = new MeetingStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("creates, lists, updates and deletes meetings", async () => {
    const a = await store.create({ title: "Weekly sync" });
    const b = await store.create();
    expect(b.title).toMatch(/^Meeting /);
    expect((await store.list()).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

    const updated = await store.update(a.id, (m) => {
      m.notes = "- ship v1";
    });
    expect(updated?.notes).toBe("- ship v1");
    expect((await store.get(a.id))?.notes).toBe("- ship v1");

    expect(await store.delete(a.id)).toBe(true);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.delete(a.id)).toBe(false);
  });

  it("serialises concurrent updates so none are lost", async () => {
    const m = await store.create();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update(m.id, (x) => {
          x.transcript.push({ id: String(i), source: "system", startMs: i, endMs: i + 1, text: "t", final: true });
        }),
      ),
    );
    expect((await store.get(m.id))?.transcript).toHaveLength(20);
  });

  it("rejects ids that are not UUIDs (no path traversal)", async () => {
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.update("..", () => {})).toBeUndefined();
  });
});
