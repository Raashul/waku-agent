// An uploaded article is a plain text / markdown object whose S3 key carries the
// ticker: <prefix><TICKER>/<name>. The body is the raw article text — no JSON,
// no frontmatter — so a curator just drops a file into the ticker's folder.

export interface ParsedKey {
  ticker: string;
  name: string;
}

const TICKER_RE = /^[A-Za-z]{2,10}$/;
const TEXT_EXT_RE = /\.(md|markdown|txt)$/i;

export function parseArticleKey(key: string, prefix: string): ParsedKey | null {
  if (!key.startsWith(prefix)) return null;
  if (!TEXT_EXT_RE.test(key)) return null;

  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null; // needs <ticker>/<name>

  const ticker = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!name || !TICKER_RE.test(ticker)) return null;

  return { ticker: ticker.toUpperCase(), name };
}
