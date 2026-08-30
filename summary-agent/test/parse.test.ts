import { describe, it, expect } from "vitest";
import { parseSummary, ParseError } from "../src/summarizer/parse.js";

describe("parseSummary", () => {
  it("splits a clean two-paragraph + sentiment response", () => {
    const raw = [
      "NVDA reported adjusted earnings of $2.22 a share on $96.22B in sales, beating estimates.",
      "",
      "The beat-and-raise and 70% growth floor point to durable AI-infrastructure demand.",
      "",
      "Sentiment: Positive",
    ].join("\n");
    const out = parseSummary(raw);
    expect(out.paragraph_1).toMatch(/^NVDA reported/);
    expect(out.paragraph_2).toMatch(/durable AI-infrastructure/);
    expect(out.sentiment).toBe("positive");
  });

  it("tolerates a preamble line and markdown headings", () => {
    const raw = [
      "Here is the summary:",
      "",
      "**What happened:** NABIL rose 3% after strong Q4 results.",
      "",
      "**Why it matters:** Signals margin recovery for commercial banks.",
      "",
      "Sentiment: positive",
    ].join("\n");
    const out = parseSummary(raw);
    expect(out.paragraph_1).toContain("NABIL rose 3%");
    expect(out.paragraph_2).toContain("margin recovery");
    expect(out.sentiment).toBe("positive");
  });

  it("defaults to neutral when no sentiment line is present", () => {
    const raw = "Paragraph one about the event.\n\nParagraph two about the impact.";
    const out = parseSummary(raw);
    expect(out.sentiment).toBe("neutral");
  });

  it("reads sentiment even when embedded mid-sentence", () => {
    const raw = "Event para.\n\nImpact para.\n\nOverall sentiment: Negative for the near term.";
    expect(parseSummary(raw).sentiment).toBe("negative");
  });

  it("collapses 3+ blocks into two paragraphs rather than failing", () => {
    const raw = "Lead-in.\n\nEvent para.\n\nImpact para.\n\nExtra nuance para.\n\nSentiment: Neutral";
    const out = parseSummary(raw);
    expect(out.paragraph_1.length).toBeGreaterThan(0);
    expect(out.paragraph_2.length).toBeGreaterThan(0);
    expect(out.paragraph_2).toContain("Extra nuance");
  });

  it("throws ParseError when it cannot find two paragraphs of prose", () => {
    expect(() => parseSummary("Sentiment: Positive")).toThrow(ParseError);
    expect(() => parseSummary("")).toThrow(ParseError);
  });
});
