/**
 * Note templates. A template only shapes the output (sections and what each
 * should contain); the user's notes and the transcript stay the source of
 * truth. Users can add their own by appending to this list.
 */
export interface TemplateSection {
  heading: string;
  /** What belongs in this section, written as guidance for the model. */
  guidance: string;
}

export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  sections: TemplateSection[];
}

export const TEMPLATES: readonly NoteTemplate[] = [
  {
    id: "general",
    name: "General meeting",
    description: "Topics discussed, decisions and next steps.",
    sections: [
      { heading: "Summary", guidance: "Two or three sentences on the purpose and outcome of the meeting." },
      { heading: "Discussion", guidance: "One sub-heading per topic, with the key points as bullets." },
      { heading: "Decisions", guidance: "Decisions that were actually made. Omit the section if none were." },
      { heading: "Next steps", guidance: "Action items as '- [ ] Owner: task (due date if mentioned)'." },
    ],
  },
  {
    id: "one-on-one",
    name: "1:1",
    description: "Updates, blockers, feedback and follow-ups between two people.",
    sections: [
      { heading: "Updates", guidance: "What each person shared about progress since last time." },
      { heading: "Blockers & concerns", guidance: "Problems raised and any support requested." },
      { heading: "Feedback", guidance: "Feedback given in either direction, stated neutrally." },
      { heading: "Follow-ups", guidance: "Commitments as '- [ ] Owner: task'." },
    ],
  },
  {
    id: "standup",
    name: "Stand-up",
    description: "Per-person yesterday / today / blockers.",
    sections: [
      { heading: "By person", guidance: "A sub-heading per speaker with Done, Next and Blocked bullets." },
      { heading: "Blockers needing help", guidance: "Only blockers that need someone else's action." },
    ],
  },
  {
    id: "customer-call",
    name: "Customer call",
    description: "Context, pain points, requirements, objections and next steps.",
    sections: [
      { heading: "Customer context", guidance: "Who they are, their team, current tools and situation." },
      { heading: "Pain points", guidance: "Problems in their own words where possible." },
      { heading: "Requirements", guidance: "Must-haves, nice-to-haves, constraints, budget and timeline if stated." },
      { heading: "Objections & questions", guidance: "Concerns raised and how they were answered." },
      { heading: "Next steps", guidance: "Agreed actions on both sides as '- [ ] Owner: task'." },
    ],
  },
  {
    id: "interview",
    name: "Candidate interview",
    description: "Background, evidence per topic and open questions.",
    sections: [
      { heading: "Background", guidance: "Relevant experience the candidate described." },
      { heading: "Evidence", guidance: "A sub-heading per topic covered, with concrete examples they gave." },
      { heading: "Candidate questions", guidance: "Questions the candidate asked." },
      { heading: "Open questions", guidance: "What remains unclear; do not score or judge the candidate." },
    ],
  },
];

export function getTemplate(id: string): NoteTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]!;
}
