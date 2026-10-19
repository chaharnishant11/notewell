import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Transcriber } from "../core/asr/types.js";
import { createEnhancer } from "../core/enhance/enhancer.js";
import { OpenAIProvider } from "../core/llm/openai.js";
import { MeetingStore, type Meeting } from "../core/store/meetings.js";
import { encodeAudioFrame, type ServerMessage } from "../shared/protocol.js";
import { createApp } from "./app.js";
import { Engine } from "./engine.js";

const fakeTranscriber: Transcriber = {
  name: "fake-asr",
  async transcribe(audio) {
    return { text: `heard ${(audio.length / 16000).toFixed(1)} seconds`, inferenceMs: 0 };
  },
};

/** Minimal OpenAI-compatible endpoint that streams a fixed answer. */
function startMockOpenAI(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["## Summary\n", "- Agreed to ", "ship the beta"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests });
    }),
  );
}

describe("notewell server", () => {
  let dir: string;
  let app: Server;
  let base: string;
  let mock: Awaited<ReturnType<typeof startMockOpenAI>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "notewell-server-"));
    mock = await startMockOpenAI();
    const provider = new OpenAIProvider({ apiKey: "test", baseUrl: mock.url, model: "mock-model" });
    app = createApp({
      engine: new Engine({ transcriber: fakeTranscriber, energyVad: true }),
      meetings: new MeetingStore(dir),
      enhancer: createEnhancer(provider),
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    base = `http://localhost:${(app.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    app.close();
    mock.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const json = async <T>(path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
  };

  it("serves the UI and rejects foreign origins and hosts", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Notewell");
    // fetch() drops forbidden headers like Host/Origin, so use raw requests.
    expect(await rawStatus(base, "/api/meetings", { origin: "https://evil.example" })).toBe(403);
    expect(await rawStatus(base, "/api/meetings", { host: "attacker.example" })).toBe(403);
    expect(await rawStatus(base, "/api/meetings", { origin: base })).toBe(200);
    expect(await rawStatus(base, "/..%2fpackage.json", {})).toBe(404);
  });

  it("creates, patches and lists meetings", async () => {
    const created = await json<Meeting>("/api/meetings", { method: "POST", body: JSON.stringify({ title: "Sync" }) });
    expect(created.status).toBe(201);
    const patched = await json<Meeting>(`/api/meetings/${created.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notes: "- beta scope" }),
    });
    expect(patched.body.notes).toBe("- beta scope");
    const list = await json<{ id: string }[]>("/api/meetings");
    expect(list.body.map((m) => m.id)).toContain(created.body.id);
  });

  it("transcribes streamed PCM over the live WebSocket and persists segments", async () => {
    const { body: meeting } = await json<Meeting>("/api/meetings", { method: "POST", body: "{}" });
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/meetings/${meeting.id}/live`);
    const messages: ServerMessage[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "start", sampleRates: { system: 48000 } }));
    await waitFor(() => messages.some((m) => m.type === "ready"));

    // 0.5 s silence, 1.5 s loud tone, 1 s silence at 48 kHz, in 100 ms frames.
    const rate = 48000;
    const total = rate * 3;
    for (let start = 0; start < total; start += rate / 10) {
      const pcm = new Int16Array(rate / 10);
      for (let i = 0; i < pcm.length; i++) {
        const t = (start + i) / rate;
        pcm[i] = t >= 0.5 && t < 2 ? Math.round(12000 * Math.sin(2 * Math.PI * 220 * t)) : 0;
      }
      ws.send(encodeAudioFrame("system", pcm));
    }
    ws.send(JSON.stringify({ type: "stop" }));
    await waitFor(() => messages.some((m) => m.type === "stopped"));
    ws.close();

    const finals = messages.flatMap((m) => (m.type === "segment" && m.segment.final ? [m.segment] : []));
    expect(finals).toHaveLength(1);
    // 1.5 s of tone plus VAD pre-roll (300 ms) and post-roll (200 ms).
    expect(finals[0]).toMatchObject({ source: "system", text: "heard 2.0 seconds" });
    expect(finals[0]!.startMs).toBeGreaterThanOrEqual(150);
    expect(finals[0]!.startMs).toBeLessThanOrEqual(500);
    const saved = await json<Meeting>(`/api/meetings/${meeting.id}`);
    expect(saved.body.transcript).toHaveLength(1);
  });

  it("buffers audio sent while models are still loading and rejects a second start", async () => {
    class SlowEngine extends Engine {
      override async transcriber() {
        await new Promise((r) => setTimeout(r, 300));
        return fakeTranscriber;
      }
    }
    const slow = createApp({
      engine: new SlowEngine({ energyVad: true }),
      meetings: new MeetingStore(dir),
      enhancer: createEnhancer(new OpenAIProvider({ apiKey: "x", baseUrl: mock.url })),
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const slowBase = `http://localhost:${(slow.address() as AddressInfo).port}`;
    try {
      const created = await fetch(`${slowBase}/api/meetings`, { method: "POST", body: "{}" });
      const meeting = (await created.json()) as Meeting;
      const ws = new WebSocket(`${slowBase.replace("http", "ws")}/api/meetings/${meeting.id}/live`);
      const messages: ServerMessage[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
      await new Promise((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "start", sampleRates: { microphone: 16000 } }));
      ws.send(JSON.stringify({ type: "start", sampleRates: { microphone: 16000 } }));
      // Everything is sent before the engine is ready.
      const pcm = new Int16Array(16000 * 3);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = i >= 8000 && i < 32000 ? Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / 16000)) : 0;
      }
      ws.send(encodeAudioFrame("microphone", pcm));
      ws.send(JSON.stringify({ type: "stop" }));
      await waitFor(() => messages.some((m) => m.type === "stopped"));
      ws.close();
      expect(messages.some((m) => m.type === "error" && m.message === "already recording")).toBe(true);
      const finals = messages.filter((m) => m.type === "segment" && m.segment.final);
      expect(finals).toHaveLength(1);
    } finally {
      slow.close();
    }
  });

  it("refuses WebSocket upgrades from foreign origins", async () => {
    const { body: meeting } = await json<Meeting>("/api/meetings", { method: "POST", body: "{}" });
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/meetings/${meeting.id}/live`, {
      headers: { origin: "https://evil.example" },
    });
    const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(error.message).toMatch(/403/);
  });

  it("streams enhancement over SSE and saves the result", async () => {
    const { body: meeting } = await json<Meeting>("/api/meetings", {
      method: "POST",
      body: JSON.stringify({ title: "Beta review", context: "Dana and Lee" }),
    });
    await json(`/api/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ notes: "ship beta?" }) });
    const res = await fetch(`${base}/api/meetings/${meeting.id}/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "general" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");

    const saved = await json<Meeting>(`/api/meetings/${meeting.id}`);
    expect(saved.body.enhanced).toMatchObject({
      templateId: "general",
      model: "mock-model",
      markdown: "## Summary\n- Agreed to ship the beta",
    });
    const request = mock.requests.at(-1) as { model: string; messages: { role: string; content: string }[] };
    expect(request.model).toBe("mock-model");
    expect(request.messages[1]!.content).toContain("<user_notes>\nship beta?\n</user_notes>");
    expect(request.messages[1]!.content).toContain("Dana and Lee");
  });
});

function rawStatus(base: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: url.port, path, headers: { host: url.host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
