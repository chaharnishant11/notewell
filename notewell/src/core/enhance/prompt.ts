import type { ChatMessage } from "../llm/types.js";
import type { Meeting } from "../store/meetings.js";
import { TranscriptStore } from "../transcript/store.js";
import type { NoteTemplate } from "./templates.js";

export interface PromptInput {
  meeting: Pick<Meeting, "title" | "context" | "notes" | "transcript">;
  template: NoteTemplate;
  /** Upper bound on transcript characters sent to the model. */
  maxTranscriptChars?: number;
  now?: Date;
}

const SYSTEM_PROMPT = `You turn a person's rough meeting notes and the meeting transcript into clear, well-organised notes.

Rules:
- The user's own notes are the backbone. Keep every point they wrote, in their wording where possible, and expand each one with the relevant detail from the transcript.
- Add important points from the transcript that the user did not capture.
- Never invent facts, names, numbers or commitments. If something is unclear in the transcript, leave it out rather than guess.
- "Me" in the transcript is the person taking notes; "Them" is everyone else on the call. Use real names only when the transcript or context makes them clear.
- Follow the requested template's sections and order. Skip a section if there is nothing for it.
- Write in Markdown: "## " for section headings, "### " for sub-headings, "- " bullets, concise phrases rather than paragraphs.
- Write in the language of the meeting.
- Output only the notes, with no preamble.`;

/** Builds the chat messages for one enhancement run. */
export function buildEnhancementMessages(input: PromptInput): ChatMessage[] {
  const { meeting, template } = input;
  const transcript = truncateMiddle(
    new TranscriptStore(meeting.transcript).toText({ timestamps: true }),
    input.maxTranscriptChars ?? 120_000,
  );
  const sections = template.sections.map((s) => `- ${s.heading}: ${s.guidance}`).join("\n");
  const user = [
    `Meeting title: ${meeting.title}`,
    `Date: ${(input.now ?? new Date()).toISOString().slice(0, 10)}`,
    meeting.context.trim() ? `Context provided by the user:\n${meeting.context.trim()}` : "",
    `Template: ${template.name}\n${sections}`,
    `<user_notes>\n${meeting.notes.trim() || "(the user took no notes)"}\n</user_notes>`,
    `<transcript>\n${transcript || "(no transcript was captured)"}\n</transcript>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Keeps the beginning and end of an over-long transcript. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n[… transcript truncated …]\n${text.slice(-half)}`;
}
