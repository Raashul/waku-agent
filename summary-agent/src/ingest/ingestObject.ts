import { config } from "../config.js";
import { nptTradingDay } from "../lib/tradingDay.js";
import { parseArticleKey } from "./parseKey.js";
import * as articlesRepo from "../db/articlesRepo.js";
import { tickerQueue } from "../summarizer/queue.js";
import { regenerate } from "../summarizer/regenerate.js";
import type { RegenerateDeps } from "../summarizer/regenerate.js";

export interface IngestOutcome {
  key: string;
  status: "enqueued" | "skipped-key" | "skipped-empty" | "skipped-old" | "already-done";
  ticker?: string;
  tradingDay?: string;
}

/**
 * Ingest one object: derive the ticker from its key, record it (idempotently),
 * and — unless it's a historical day we shouldn't replay — enqueue a
 * regeneration for its ticker/day.
 */
export async function ingestObject(key: string, deps: RegenerateDeps): Promise<IngestOutcome> {
  const parsed = parseArticleKey(key, config.articlesPrefix);
  if (!parsed) return { key, status: "skipped-key" };

  const obj = await deps.store.getObject(key);
  if (!obj.body.trim()) return { key, status: "skipped-empty", ticker: parsed.ticker };

  const tradingDay = nptTradingDay(obj.lastModified);
  const { row, isNew } = await articlesRepo.insertIfNew({
    ticker: parsed.ticker,
    tradingDay,
    s3Key: key,
    uploadedAt: obj.lastModified.toISOString(),
  });

  if (!isNew && row.summarized_at) return { key, status: "already-done", ticker: parsed.ticker, tradingDay };

  // Guard against a DB reset replaying weeks of history against the LLM.
  if (!config.backfill && tradingDay < nptTradingDay()) {
    return { key, status: "skipped-old", ticker: parsed.ticker, tradingDay };
  }

  tickerQueue.enqueue(parsed.ticker, () => regenerate(parsed.ticker, tradingDay, deps));
  return { key, status: "enqueued", ticker: parsed.ticker, tradingDay };
}
