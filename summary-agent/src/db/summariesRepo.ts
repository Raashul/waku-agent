import { pool } from "./pool.js";
import { nptTradingDay } from "../lib/tradingDay.js";
import type { LatestSummary, SummaryRow, Sentiment, SummaryStatus } from "../types.js";

export async function nextVersion(ticker: string, tradingDay: string): Promise<number> {
  const { rows } = await pool.query<{ max: number | null }>(
    `SELECT MAX(version) AS max FROM stock_summaries WHERE ticker = $1 AND trading_day = $2`,
    [ticker, tradingDay],
  );
  return (rows[0]?.max ?? 0) + 1;
}

export async function insertVersion(v: {
  ticker: string;
  tradingDay: string;
  version: number;
  status?: SummaryStatus;
}): Promise<SummaryRow> {
  const { rows } = await pool.query<SummaryRow>(
    `INSERT INTO stock_summaries (ticker, trading_day, version, status)
     VALUES ($1, $2, $3, COALESCE($4, 'generating'))
     RETURNING *`,
    [v.ticker, v.tradingDay, v.version, v.status ?? null],
  );
  return rows[0]!;
}

export async function markStatus(
  id: string,
  patch: {
    status: SummaryStatus;
    paragraph_1?: string;
    paragraph_2?: string;
    sentiment?: Sentiment;
    model_used?: string;
  },
): Promise<SummaryRow> {
  const { rows } = await pool.query<SummaryRow>(
    `UPDATE stock_summaries SET
       status       = $2,
       paragraph_1  = COALESCE($3, paragraph_1),
       paragraph_2  = COALESCE($4, paragraph_2),
       sentiment    = COALESCE($5, sentiment),
       model_used   = COALESCE($6, model_used),
       generated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, patch.status, patch.paragraph_1 ?? null, patch.paragraph_2 ?? null, patch.sentiment ?? null, patch.model_used ?? null],
  );
  return rows[0]!;
}

export async function linkArticles(summaryId: string, articleIds: string[]): Promise<void> {
  if (articleIds.length === 0) return;
  await pool.query(
    `INSERT INTO summary_articles (summary_id, article_id)
     SELECT $1, UNNEST($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [summaryId, articleIds],
  );
}

/**
 * Latest published summary for a ticker. Prefers today's NPT trading day; if
 * there is none, falls back to the most recent published summary from any day
 * (Q1 decision) and marks it `stale` so the UI can show "as of <date>".
 * Returns null only if the ticker has never had a published summary.
 */
export async function getLatest(ticker: string): Promise<LatestSummary | null> {
  const { rows } = await pool.query<SummaryRow & { article_count: string }>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM summary_articles sa WHERE sa.summary_id = s.id) AS article_count
       FROM stock_summaries s
      WHERE s.ticker = $1 AND s.status = 'published'
      ORDER BY (s.trading_day = $2::date) DESC, s.trading_day DESC, s.version DESC
      LIMIT 1`,
    [ticker, nptTradingDay()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    article_count: Number(r.article_count),
    stale: r.trading_day !== nptTradingDay(),
  };
}

export async function getHistory(ticker: string, tradingDay: string): Promise<SummaryRow[]> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT * FROM stock_summaries
      WHERE ticker = $1 AND trading_day = $2
      ORDER BY version DESC`,
    [ticker, tradingDay],
  );
  return rows;
}

export interface TrendingItem {
  ticker: string;
  version: number;
  sentiment: Sentiment;
  trading_day: string;
  paragraph_1: string;
  generated_at: string;
}

/** Most recently generated published summary per ticker. */
export async function listTrending(limit: number): Promise<TrendingItem[]> {
  const { rows } = await pool.query<TrendingItem>(
    `SELECT DISTINCT ON (ticker)
            ticker, version, sentiment, trading_day, paragraph_1, generated_at
       FROM stock_summaries
      WHERE status = 'published'
      ORDER BY ticker, generated_at DESC`,
    [],
  );
  rows.sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));
  return rows.slice(0, limit);
}
