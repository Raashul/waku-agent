// One prompt, same shape every time — so every stock's card renders identically.
// Verbatim intent from .lavish/nepal-stock-cortex.html ("One prompt, same shape").

export const SYSTEM_PROMPT = `You summarize NEPSE stock news. You are given ALL of today's articles for one ticker (one or more). Write ONE synthesis, in EXACTLY this shape:

Paragraph 1 (What happened): the event, using only dates and numbers that appear in the articles.

Paragraph 2 (Why it matters): a plain-language read on the likely impact.

Then one final line: Sentiment: Positive | Negative | Neutral

Rules: neutral tone, no advice, no speculation beyond the articles, at most ~120 words total, name the ticker once up front. Output plain text only.`;

export function buildUserPrompt(ticker: string, articles: string[]): string {
  const joined = articles
    .map((a, i) => `--- Article ${i + 1} ---\n${a.trim()}`)
    .join("\n\n");
  return `Ticker: ${ticker}\nNumber of articles today: ${articles.length}\n\n${joined}`;
}
