import { describe, expect, it } from "vitest";
import { cleanTranscriptText } from "./clean.js";

describe("cleanTranscriptText", () => {
  it.each([
    ["[BLANK_AUDIO]", 1],
    [" (music) ", 3],
    ["♪♪", 2],
    [" Thank you.", 1.2],
    ["the the the the the the the the the", 5],
  ])("drops non-speech %j", (raw, seconds) => {
    expect(cleanTranscriptText(raw, seconds)).toBe("");
  });

  it("keeps real speech and normalises whitespace", () => {
    expect(cleanTranscriptText("  Let's   ship it  on Friday. ", 2)).toBe("Let's ship it on Friday.");
    expect(cleanTranscriptText("Thank you.", 4)).toBe("Thank you.");
  });
});
