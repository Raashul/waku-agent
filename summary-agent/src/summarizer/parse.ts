// Turn the model's free text into the fixed shape the UI renders: two
// paragraphs + a sentiment label. Deliberately lenient — a strict parser that
// throws on any drift would leave a stock page blank whenever the model adds a
// lead-in line or an extra paragraph. We only give up if we truly cannot find
// two paragraphs of prose.

export type Sentiment = "positive" | "negative" | "neutral";

export interface ParsedSummary {
  paragraph_1: string;
  paragraph_2: string;
  sentiment: Sentiment;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const SENTIMENT_LINE_RE = /sentiment\s*:/i;
const SENTIMENT_VALUE_RE = /sentiment\s*:\s*(positive|negative|neutral)/i;
const PREAMBLE_RE = /^(here (is|are)\b|below is\b|the following\b|summary\s*:)/i;
// "Paragraph 1 (What happened):", "**What happened:**", "Why it matters -" ...
const LABEL_RE =
  /^\s*(\*\*|__)?\s*(paragraph\s*\d+\s*\([^)]*\)|what happened|why it matters)\s*(\*\*|__)?\s*[:\-–—]\s*/i;
const MIN_PARAGRAPH_LEN = 25;

export function parseSummary(raw: string): ParsedSummary {
  const lines = raw.split("\n");

  let sentiment: Sentiment = "neutral";
  const kept: string[] = [];
  for (const line of lines) {
    if (SENTIMENT_LINE_RE.test(line)) {
      const m = line.match(SENTIMENT_VALUE_RE);
      if (m) sentiment = m[1]!.toLowerCase() as Sentiment;
      continue; // drop the sentiment line from the prose
    }
    kept.push(line);
  }

  let blocks = kept
    .join("\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim().replace(LABEL_RE, "").trim())
    .filter(Boolean);

  // Drop leading non-paragraph blocks while real prose still follows: a bare
  // ticker line ("NVDA"), a lead-in ("Here is the summary:"), a stray heading.
  while (blocks.length > 2 && (blocks[0]!.length < MIN_PARAGRAPH_LEN || PREAMBLE_RE.test(blocks[0]!))) {
    blocks = blocks.slice(1);
  }

  if (blocks.length < 2) {
    throw new ParseError(
      `expected two paragraphs, got ${blocks.length} (raw length ${raw.length})`,
    );
  }

  const paragraph_1 = blocks[0]!;
  const paragraph_2 = blocks.slice(1).join(" ").replace(/\s+/g, " ").trim();

  return { paragraph_1, paragraph_2, sentiment };
}
