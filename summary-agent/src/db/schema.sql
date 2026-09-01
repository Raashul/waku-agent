-- Nepal Stock Cortex demo schema. Portable Postgres; matches the production
-- design in summary-agent/plan.md 1:1.

CREATE TABLE IF NOT EXISTS articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        VARCHAR(10)  NOT NULL,
  trading_day   DATE         NOT NULL,
  s3_key        TEXT         NOT NULL UNIQUE,   -- idempotency key: one ingest per object
  source        VARCHAR(120),
  uploaded_by   VARCHAR(120) NOT NULL DEFAULT 's3-upload',
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  summarized_at TIMESTAMPTZ                      -- NULL => still needs a summary (crash-safe re-drive)
);
CREATE INDEX IF NOT EXISTS idx_articles_ticker_day ON articles (ticker, trading_day);
CREATE INDEX IF NOT EXISTS idx_articles_pending ON articles (summarized_at) WHERE summarized_at IS NULL;

CREATE TABLE IF NOT EXISTS stock_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker       VARCHAR(10)  NOT NULL,
  trading_day  DATE         NOT NULL,
  version      INT          NOT NULL,
  paragraph_1  TEXT         NOT NULL DEFAULT '',
  paragraph_2  TEXT         NOT NULL DEFAULT '',
  sentiment    VARCHAR(8)   NOT NULL DEFAULT 'neutral'
               CHECK (sentiment IN ('positive','negative','neutral')),
  model_used   VARCHAR(80)  NOT NULL DEFAULT '',
  status       VARCHAR(12)  NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','generating','published','failed')),
  generated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (ticker, trading_day, version)
);
CREATE INDEX IF NOT EXISTS idx_summaries_ticker_latest
  ON stock_summaries (ticker, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_ticker_day_ver
  ON stock_summaries (ticker, trading_day, version DESC);

CREATE TABLE IF NOT EXISTS summary_articles (
  summary_id  UUID NOT NULL REFERENCES stock_summaries(id) ON DELETE CASCADE,
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, article_id)
);
