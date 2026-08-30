import type { Sentiment } from "./summarizer/parse.js";

export type { Sentiment };
export type SummaryStatus = "pending" | "generating" | "published" | "failed";

export interface ArticleRow {
  id: string;
  ticker: string;
  trading_day: string; // YYYY-MM-DD
  s3_key: string;
  source: string | null;
  uploaded_by: string;
  uploaded_at: string;
  summarized_at: string | null;
}

export interface SummaryRow {
  id: string;
  ticker: string;
  trading_day: string;
  version: number;
  paragraph_1: string;
  paragraph_2: string;
  sentiment: Sentiment;
  model_used: string;
  status: SummaryStatus;
  generated_at: string;
}

export interface LatestSummary extends SummaryRow {
  article_count: number;
  /** true when trading_day is not the current NPT trading day (UI shows "as of ...") */
  stale: boolean;
}
