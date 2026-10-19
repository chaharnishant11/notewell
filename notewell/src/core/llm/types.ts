export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Provider-specific model id; providers fall back to their default. */
  model?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** A streaming chat model. Yields text deltas as they arrive. */
export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  streamChat(request: ChatRequest): AsyncIterable<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** Collects a full response from a streaming provider. */
export async function completeChat(provider: LLMProvider, request: ChatRequest): Promise<string> {
  let text = "";
  for await (const delta of provider.streamChat(request)) text += delta;
  return text;
}
