/**
 * Live enhancement against the real OpenAI API (or OPENAI_BASE_URL):
 *   OPENAI_API_KEY=sk-... npm run test:live -- enhance
 * Behind an HTTPS proxy, also set NODE_USE_ENV_PROXY=1.
 */
import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../llm/openai.js";
import type { Meeting } from "../store/meetings.js";
import { createEnhancer } from "./enhancer.js";

const meeting: Meeting = {
  id: "00000000-0000-0000-0000-000000000000",
  title: "Beta launch check-in (example)",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  context: "Example meeting between Dana (design lead) and Lee (engineering).",
  notes: "pricing too high for SMB\nship beta by friday\ndana -> security review?",
  transcript: [
    ["microphone", "Okay, quick check-in on the beta. Where are we on the launch date?"],
    ["system", "Engineering is on track for Friday as long as QA signs off on Thursday."],
    ["microphone", "Good. The other thing from the customer calls is pricing feels too high for small teams."],
    ["system", "Yeah, two SMB prospects asked for a starter tier, something under twenty dollars a seat."],
    ["microphone", "Let's model a starter tier before the beta goes out. Dana, can you own the security review?"],
    ["system", "Sure, I'll send the questionnaire to their IT team by Wednesday."],
  ].map(([source, text], i) => ({
    id: String(i),
    source: source as "microphone" | "system",
    startMs: i * 6000,
    endMs: i * 6000 + 5000,
    text: text!,
    final: true,
  })),
  enhanced: null,
};

describe("enhancement (live LLM)", () => {
  it("streams structured notes that keep the user's points", { timeout: 180_000 }, async () => {
    const provider = new OpenAIProvider();
    let deltas = 0;
    const result = await createEnhancer(provider).enhance({ meeting, templateId: "general" }, () => deltas++);
    console.log(`model: ${result.model}, ${deltas} deltas\n\n${result.markdown}`);
    expect(deltas).toBeGreaterThan(1);
    expect(result.markdown).toMatch(/^## /m);
    expect(result.markdown.toLowerCase()).toContain("friday");
    expect(result.markdown.toLowerCase()).toMatch(/starter tier|pricing/);
  });
});
