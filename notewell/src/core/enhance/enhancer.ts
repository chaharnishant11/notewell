import type { LLMProvider } from "../llm/types.js";
import type { EnhancedNotes, Meeting } from "../store/meetings.js";
import { buildEnhancementMessages } from "./prompt.js";
import { getTemplate } from "./templates.js";

export interface EnhanceRequest {
  meeting: Meeting;
  templateId: string;
  signal?: AbortSignal;
}

export interface Enhancer {
  describe(): { provider: string; model: string };
  enhance(request: EnhanceRequest, onDelta: (text: string) => void): Promise<EnhancedNotes>;
}

/** Streams enhanced notes from an LLM provider. */
export function createEnhancer(provider: LLMProvider, options: { model?: string } = {}): Enhancer {
  const model = options.model ?? provider.defaultModel;
  return {
    describe: () => ({ provider: provider.name, model }),
    async enhance(request, onDelta) {
      const template = getTemplate(request.templateId);
      const messages = buildEnhancementMessages({ meeting: request.meeting, template });
      let markdown = "";
      for await (const delta of provider.streamChat({
        messages,
        model,
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        markdown += delta;
        onDelta(delta);
      }
      return { templateId: template.id, markdown: markdown.trim(), model, createdAt: new Date().toISOString() };
    },
  };
}
