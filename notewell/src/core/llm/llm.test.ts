import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "./openai.js";
import { parseSse } from "./sse.js";
import { completeChat, LLMError } from "./types.js";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  for (const p of parts) yield enc.encode(p);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseSse", () => {
  it("handles events split across chunks, CRLF, comments and multi-line data", async () => {
    const events = await collect(
      parseSse(chunks(": keep-alive\n", "event: delta\nda", "ta: one\r\ndata: two\r\n\r\n", "data: tail")),
    );
    expect(events).toEqual([
      { event: "delta", data: "one\ntwo" },
      { event: "message", data: "tail" },
    ]);
  });
});

function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.join(""), { status, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAIProvider", () => {
  it("streams content deltas and sends a Chat Completions request", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    };
    const provider = new OpenAIProvider({ apiKey: "test-key", baseUrl: "http://llm.local/v1/", model: "m1", fetchImpl });
    const text = await completeChat(provider, { messages: [{ role: "user", content: "hi" }], maxOutputTokens: 50 });
    expect(text).toBe("Hello");
    expect(captured!.url).toBe("http://llm.local/v1/chat/completions");
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_completion_tokens: 50,
    });
  });

  it("surfaces API errors with status", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const provider = new OpenAIProvider({ apiKey: "x", fetchImpl });
    const err = await completeChat(provider, { messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toMatchObject({ status: 401, message: expect.stringContaining("bad key") });
  });
});
