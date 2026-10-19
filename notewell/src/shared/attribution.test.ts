import { describe, expect, it } from "vitest";
import { makeUserTextMatcher, normalizeTokens } from "./attribution.js";

describe("attribution", () => {
  const notes = "pricing too high for SMB\n- ship beta by **Friday**\nok";
  const isMine = makeUserTextMatcher(notes);

  it("normalises markdown and punctuation", () => {
    expect(normalizeTokens("**Ship** the [beta](https://x.y) by Friday!")).toEqual(["ship", "the", "beta", "by", "friday"]);
  });

  it("recognises user lines kept or lightly expanded by the model", () => {
    expect(isMine("Pricing is too high for SMB customers; they want a starter tier")).toBe(true);
    expect(isMine("Ship the beta by Friday (Dana owns QA)")).toBe(true);
  });

  it("treats new material as AI-added", () => {
    expect(isMine("Dana will send the security questionnaire")).toBe(false);
    expect(isMine("ok")).toBe(false); // one-word user lines are too weak to match
  });
});
