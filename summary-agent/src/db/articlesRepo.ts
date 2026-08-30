import { pool } from "./pool.js";
import type { ArticleRow } from "../types.js";

export interface NewArticle {
  ticker: string;
  tradingDay: string;
  s3Key: string;
  source?: string | null;
  uploadedBy?: string;
  uploadedAt?: string; // ISO; defaults to now()
}

/**
 * Insert an article row, or return the existing one if this s3_key was already
 * ingested. `isNew` tells the caller whether a summary needs to be triggered.
 */
export async function insertIfNew(a: NewArticle): Promise<{ row: ArticleRow; isNew: boolean }> {
  const inserted = await pool.query<ArticleRow>(
    `INSERT INTO articles (ticker, trading_day, s3_key, source, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 's3-upload'), COALESCE($6::timestamptz, now()))
     ON CONFLICT (s3_key) DO NOTHING
     RETURNING *`,
    [a.ticker, a.tradingDay, a.s3Key, a.source ?? null, a.uploadedBy ?? null, a.uploadedAt ?? null],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], isNew: true };

  const existing = await pool.query<ArticleRow>(`SELECT * FROM articles WHERE s3_key = $1`, [a.s3Key]);
  return { row: existing.rows[0]!, isNew: false };
}

export async function knownKeys(): Promise<Set<string>> {
  const { rows } = await pool.query<{ s3_key: string }>(`SELECT s3_key FROM articles`);
  return new Set(rows.map((r) => r.s3_key));
}

export async function listForDay(ticker: string, tradingDay: string): Promise<ArticleRow[]> {
  const { rows } = await pool.query<ArticleRow>(
    `SELECT * FROM articles WHERE ticker = $1 AND trading_day = $2 ORDER BY uploaded_at ASC`,
    [ticker, tradingDay],
  );
  return rows;
}

/** Articles that were ingested but never got a successful summary — crash-safe re-drive. */
export async function pendingArticles(): Promise<ArticleRow[]> {
  const { rows } = await pool.query<ArticleRow>(
    `SELECT * FROM articles WHERE summarized_at IS NULL ORDER BY uploaded_at ASC`,
  );
  return rows;
}

export async function markSummarized(articleIds: string[], when: string): Promise<void> {
  if (articleIds.length === 0) return;
  await pool.query(`UPDATE articles SET summarized_at = $2 WHERE id = ANY($1::uuid[])`, [
    articleIds,
    when,
  ]);
}
