import { parseSse } from "../../shared/sse.js";
import { LLMError, type ChatRequest, type LLMProvider } from "./types.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  /** Any OpenAI-compatible Chat Completions endpoint (Azure, Groq, Ollama, LM Studio…). */
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI Chat Completions with server-sent-event streaming. Uses plain fetch
 * so there is no SDK dependency and compatible servers work unchanged.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.defaultModel = options.model ?? process.env.NOTEWELL_OPENAI_MODEL ?? "gpt-5-mini";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<string> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: request.messages,
      stream: true,
    };
    if (request.maxOutputTokens) body.max_completion_tokens = request.maxOutputTokens;

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new LLMError(`OpenAI request failed (${response.status}): ${extractError(detail)}`, response.status);
    }

    for await (const event of parseSse(response.body as AsyncIterable<Uint8Array>)) {
      if (event.data === "[DONE]") return;
      let payload: { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } };
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue; // tolerate non-JSON keep-alives from compatible servers
      }
      if (payload.error) throw new LLMError(payload.error.message ?? "stream error");
      const delta = payload.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

function extractError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // fall through to raw text
  }
  return body.slice(0, 300) || "no response body";
}
