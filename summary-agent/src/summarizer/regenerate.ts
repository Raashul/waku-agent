import * as articlesRepo from "../db/articlesRepo.js";
import * as summariesRepo from "../db/summariesRepo.js";
import { pool } from "../db/pool.js";
import { log } from "../lib/log.js";
import { parseSummary, ParseError } from "./parse.js";
import type { ObjectStore } from "../storage/index.js";
import type { LlmDriver } from "./llm/index.js";
import type { SummaryRow } from "../types.js";

export interface RegenerateDeps {
  store: ObjectStore;
  llm: LlmDriver;
}

export interface RegenerateResult {
  status: "published" | "failed" | "skipped";
  ticker: string;
  tradingDay: string;
  version?: number;
  summaryId?: string;
}

/**
 * Re-synthesize "today's summary" for one ticker from every article for that
 * trading day. Idempotent-ish: always creates a new version. Crash-safe: the
 * feeding articles are only marked summarized after a row reaches a terminal
 * state, so a process that dies mid-call leaves them for the poller to re-drive.
 */
export async function regenerate(
  ticker: string,
  tradingDay: string,
  deps: RegenerateDeps,
): Promise<RegenerateResult> {
  const articles = await articlesRepo.listForDay(ticker, tradingDay);
  if (articles.length === 0) return { status: "skipped", ticker, tradingDay };

  // Idempotency: if every article for the day is already folded into a published
  // version, a redundant re-drive has nothing to do. (A genuinely new article
  // arrives with summarized_at = NULL and skips this.)
  if (articles.every((a) => a.summarized_at)) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM stock_summaries
        WHERE ticker = $1 AND trading_day = $2 AND status = 'published'`,
      [ticker, tradingDay],
    );
    if ((rows[0]?.n ?? 0) > 0) return { status: "skipped", ticker, tradingDay };
  }

  const bodies = await Promise.all(articles.map((a) => deps.store.getObject(a.s3_key)));
  const articleIds = articles.map((a) => a.id);

  const row = await insertVersionWithRetry(ticker, tradingDay);
  log(`[summary] ${ticker} ${tradingDay} v${row.version}: generating from ${articles.length} article(s)...`);
  const startedAt = Date.now();

  try {
    const { text, model } = await withRetry(() =>
      deps.llm.summarize({ ticker, articles: bodies.map((b) => b.body) }),
    );
    const parsed = parseSummary(text);
    await summariesRepo.markStatus(row.id, {
      status: "published",
      paragraph_1: parsed.paragraph_1,
      paragraph_2: parsed.paragraph_2,
      sentiment: parsed.sentiment,
      model_used: model,
    });
    await summariesRepo.linkArticles(row.id, articleIds);
    await articlesRepo.markSummarized(articleIds, new Date().toISOString());
    log(
      `[summary] ${ticker} ${tradingDay} v${row.version}: published (${parsed.sentiment}, model=${model}, ${Date.now() - startedAt}ms)`,
    );
    return { status: "published", ticker, tradingDay, version: row.version, summaryId: row.id };
  } catch (err) {
    await summariesRepo.markStatus(row.id, { status: "failed" });
    // Content failure (bad model output), not a crash: mark the articles done so
    // the poller doesn't retry this forever. The `failed` row stays visible.
    if (err instanceof ParseError || isLlmError(err)) {
      await articlesRepo.markSummarized(articleIds, new Date().toISOString());
    }
    log(
      `[summary] ${ticker} ${tradingDay} v${row.version}: FAILED - ${err instanceof Error ? err.message : err}`,
    );
    return { status: "failed", ticker, tradingDay, version: row.version, summaryId: row.id };
  }
}

function isLlmError(err: unknown): boolean {
  return err instanceof Error && !(err instanceof ParseError);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

async function insertVersionWithRetry(ticker: string, tradingDay: string): Promise<SummaryRow> {
  for (let i = 0; i < 3; i++) {
    const version = await summariesRepo.nextVersion(ticker, tradingDay);
    try {
      return await summariesRepo.insertVersion({ ticker, tradingDay, version, status: "generating" });
    } catch (e: any) {
      if (e?.code === "23505" && i < 2) continue; // unique_violation -> re-read max, retry
      throw e;
    }
  }
  throw new Error("could not allocate a summary version");
}
