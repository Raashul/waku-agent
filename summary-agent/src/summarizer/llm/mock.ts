import type { LlmDriver, LlmResult, SummarizeInput } from "./driver.js";

function firstSentence(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

/**
 * Deterministic, no network. Echoes real content from the articles so tests can
 * assert "both articles are represented" without a live model.
 */
export class MockLlm implements LlmDriver {
  readonly name = "mock";

  async summarize({ ticker, articles }: SummarizeInput): Promise<LlmResult> {
    const leads = articles.map(firstSentence);
    const p1 = `${ticker}: ${leads.join(" ")}`.slice(0, 600);
    const p2 =
      `Across ${articles.length} article(s) today, the combined picture for ${ticker} ` +
      `centers on the items above; treat this as a synthesized TLDR, not advice.`;
    const sentiment = /surge|jump|rose|beat|record|up \d/i.test(articles.join(" "))
      ? "Positive"
      : "Neutral";
    return {
      text: `${p1}\n\n${p2}\n\nSentiment: ${sentiment}`,
      model: "mock",
    };
  }
}
