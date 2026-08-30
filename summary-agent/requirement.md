# summary-agent — High-level requirements

**Status:** draft v1 · **Date:** 2026-08-27 · **Owner:** MoneyMitra

Companion design artifacts:
- `.lavish/nepal-stock-cortex.html` — the concept ("Nepal Stock Cortex")
- `.lavish/nepal-stock-cortex-plan.html` — the phased implementation plan (mock vs production tiers)

---

## 1. Problem

MoneyMitra's stock pages (Company detail, Home, Market data) show price and volume
only. There is no plain-language "what happened and why is it moving" for a NEPSE
stock on a given day. Nepal has no automated financial-news API, so a US-style
real-time feed is not possible in v1.

## 2. What we are building

A small standalone **Node.js + TypeScript service** — `summary-agent` — that:

1. Watches an **S3 bucket** where a human uploads curated article JSON files
   **directly through the AWS console** (no upload tool, no API on the ingest path
   for the demo). The raw article in S3 is the source of truth, never overwritten.
2. **Discovers new objects and LLM-summarizes them** — no manual "summarize"
   click. Discovery is by polling the bucket (demo) or by S3 Event Notifications
   → SQS (production upgrade); either way the uploader does nothing but drop the file.
3. Regenerates **one TLDR per ticker per NEPSE trading day**, re-synthesized from
   *every* article for that ticker that day, and stored as a new **version** each time.
4. Exposes a **read API** that the money-mitra-demo frontend calls from the Market /
   Company pages to render an "AI analysis for today" card.

This is the **demo tier** of the plan artifact: real S3 + real LLM, but a single
Node process and SQLite instead of SQS FIFO + Postgres. The data shapes are chosen
so the production swap is 1:1.

## 3. Goals

- G1 — Dropping an article JSON into the S3 bucket (via the AWS console) results in
  a fresh AI summary within one poll interval, with no further human action.
- G2 — `GET /api/stocks/{ticker}/summary` returns today's latest AI analysis in a
  fixed shape: two paragraphs + a sentiment label + a "generated at" time.
- G3 — A second article for the same ticker the same day **regenerates** the
  summary from both articles (version N+1); it never blindly overwrites context.
- G4 — Runs fully offline for demos: a watched local folder stands in for the S3
  bucket, and a mock LLM driver returns a canned summary — no AWS account or API key.
- G5 — Newcomer-legible: one responsibility per module, typed boundaries, tests
  that read as documentation.

## 4. Non-goals (v1)

- NG1 — Automated scraping / news ingestion. A human curates the article JSON and
  uploads it by hand.
- NG2 — An upload tool, admin panel, or ingest API. The demo uploads via the AWS
  console; a `POST /api/admin/articles` route is an optional later addition, not
  on the critical path.
- NG3 — Real-time freshness. Summaries are async; the UI shows "generated at".
- NG4 — Admin authentication. Not needed while upload is console-only (IAM covers
  it); becomes an open question if an upload form is ever built.
- NG5 — Postgres, SQS FIFO, multi-worker horizontal scale. Designed for, not built.
- NG6 — Backfill / historical migration. The feature starts from an empty store.
- NG7 — Multi-language summaries, portfolio-level or market-wide synthesis.

## 5. Users & use cases

| Actor | Use case |
| --- | --- |
| Admin / curator | Authors an article JSON per the documented shape and uploads it to the S3 bucket via the AWS console; expects a summary to appear shortly after. |
| Market-page reader | Opens a stock's page and reads the AI TLDR + sentiment badge for today. |
| Home / Market tab | Shows a short "trending summaries" list across tickers. |
| Developer (demo) | Runs `npm run seed:demo` offline (drops files into the watched folder) and sees an end-to-end summary printed. |

## 6. Functional requirements

- FR1 — **Object shape.** A source article is a JSON object with `ticker`, `text`,
  `source`, optional `trading_day` (NPT `YYYY-MM-DD`), optional `uploaded_by`.
  It is uploaded by hand to the bucket under the `articles/` prefix; the **object
  key is opaque** (any `articles/**/*.json`) — the service reads all fields from
  the body, not the key.
- FR2 — **Discovery.** The service finds new objects on its own. Demo: poll
  `ListObjectsV2` over the `articles/` prefix on an interval, plus one full scan at
  startup. Production upgrade: S3 `ObjectCreated` → SQS FIFO → consumer. Neither
  path requires the uploader to call the service.
- FR3 — **Idempotent ingest.** Each object is summarized exactly once. `s3_key` is
  UNIQUE in the DB; an object already recorded is skipped on subsequent polls. A
  malformed object is logged and marked seen, not retried forever.
- FR4 — **Trading day.** If the object omits `trading_day`, the service computes it
  as the Asia/Kathmandu (NPT, UTC+05:45) calendar date **at discovery time** and
  stores it. It is never re-derived from UTC at query time.
- FR5 — **Regenerate from the whole day.** On each new object, load *all* of that
  ticker's articles for that `trading_day` and send them together to the LLM.
- FR6 — **Fixed-shape synthesis.** LLM returns exactly: paragraph 1 (what happened),
  paragraph 2 (why it matters), and one sentiment of `positive | negative | neutral`.
  Total ≤ ~120 words, neutral tone, no advice, no speculation beyond the articles.
- FR7 — **Versioning.** Each regeneration inserts `version = max(version)+1` for
  `(ticker, trading_day)`. Prior versions are retained for history / audit.
- FR8 — **Per-ticker serialization.** Two objects for the same ticker discovered in
  the same cycle (or seconds apart) must produce v1 then v2 from a consistent read
  — never two racing v2 rows. Demo: in-process per-ticker queue. Production:
  SQS FIFO `MessageGroupId = ticker` plus a `UNIQUE (ticker, trading_day, version)`
  backstop.
- FR9 — **Read: latest.** `GET /api/stocks/{ticker}/summary` → latest **published**
  version for today (paragraphs, sentiment, `generated_at`, `version`, `model_used`,
  `article_count`). 404 when none exists for today.
- FR10 — **Read: history.** `GET /api/stocks/{ticker}/summary/history?day=YYYY-MM-DD`
  → all versions for that ticker/day, newest first.
- FR11 — **Read: trending.** `GET /api/market/summaries?limit=N` → most recently
  generated summaries across tickers, for Home / Market tab.
- FR12 — **Failure isolation.** Summary status lifecycle
  `pending → generating → published | failed`. The read API only ever serves
  `published`. A failed regeneration leaves the previous published version live.
- FR13 — **Provider-neutral LLM.** A driver interface with `anthropic`, `openai`,
  and `mock` implementations, selected by env. Docs name providers neutrally.
- FR14 — **Config by environment.** No secrets in code; `.env.example` documents
  every variable. Missing LLM/S3 config falls back to mock/`fs` drivers, not a crash.

## 7. Non-functional requirements

- NFR1 — **Simplicity first.** Single process, stdlib + a short dependency list
  (Express, AWS SDK v3, an LLM SDK, `better-sqlite3`, `zod`, `pino`). No SQS, no
  Lambda, no bucket-notification config needed to run the demo.
- NFR2 — **Latency.** Read endpoints < 100 ms (single indexed lookup). Discovery
  latency = the poll interval (default ~15 s); summary generation then takes
  seconds. Callers never block on generation.
- NFR3 — **Portability.** SQLite schema is the Postgres schema minus UUID/`now()`
  defaults; the object store is an interface with `fs` and `s3` implementations.
- NFR4 — **Testability.** Deterministic tests with the mock LLM and `fs` store:
  version increments, both articles represented, per-ticker serialization,
  trading-day boundary, idempotent re-poll, read contract. Tests live under `test/`.
- NFR5 — **Observability.** Structured logs (`pino`); each generation logs ticker,
  trading day, input article count, model, latency, resulting version, status.
- NFR6 — **Cost awareness.** Re-sending all of a day's articles each time is
  acceptable at low volume; the known scaling fix (feed previous summary + new
  article) is documented, not built. Poll cost is one `ListObjectsV2` per interval.
- NFR7 — **No emojis** in any CLI or HTTP-facing text (matches repo convention).

## 8. Data model (summary)

- `articles` — one row per discovered article: `id`, `ticker`, `trading_day`,
  `s3_key` (unique), `source`, `uploaded_by`, `uploaded_at`.
- `stock_summaries` — one row per generated version: `id`, `ticker`, `trading_day`,
  `version`, `paragraph_1`, `paragraph_2`, `sentiment`, `model_used`, `status`,
  `generated_at`; `UNIQUE (ticker, trading_day, version)`.
- `summary_articles` — join: which articles fed which version
  (`summary_id`, `article_id`).

Raw article bodies live only in S3; the DB holds metadata + generated text.

## 9. API surface (summary)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/stocks/{ticker}/summary` | Latest published summary for today |
| GET | `/api/stocks/{ticker}/summary/history?day=YYYY-MM-DD` | All versions for a ticker/day |
| GET | `/api/market/summaries?limit=N` | Recent summaries across tickers |
| GET | `/api/health` | Liveness + which drivers are active + last poll time |
| POST | `/api/admin/articles` | *(optional, later)* upload `{ ticker, text, source }` for an admin panel — writes the same object shape to S3; not part of the console-upload demo |

## 10. Assumptions & constraints

- A1 — Article JSON is hand-authored per FR1 and uploaded via the AWS console. The
  demo trusts the file shape; a `zod` check rejects malformed objects (FR3).
- A2 — Ticker symbols match the NEPSE symbols already in
  `money-mitra-demo/server/data/db.mjs` (`NABIL`, `UPPER`, ...). Format check only
  in v1, no canonical-list validation.
- A3 — Article text is plain text or simple HTML, English, one article per object.
- A4 — Low volume: a handful of articles per ticker per day at most.
- A5 — The demo may point at a real S3 bucket or LocalStack/MinIO, or run fully
  offline against a watched local folder.
- A6 — This service is deployed alongside, not inside, money-mitra-demo. The
  frontend calls it over HTTP with a configurable base URL.
- A7 — The service has IAM read access (`s3:ListBucket`, `s3:GetObject`) to the
  bucket/prefix. Write access is only needed if the optional upload API is built.

## 11. Risks & open questions

- Q1 — **Poll interval vs. freshness.** Shorter interval = fresher summaries, more
  `ListObjectsV2` calls. Default ~15 s; revisit if the bucket grows large (switch
  to the S3-event path rather than a faster poll).
- Q2 — **Malformed / partial objects.** A file uploaded and still being written, or
  bad JSON — handled by validate-then-mark-seen, but define whether a corrected
  re-upload under the *same key* should re-trigger (v1: no, key is the idempotency
  key; upload under a new key to re-run).
- Q3 — **Trading-day boundary.** Objects without `trading_day` uploaded near NPT
  midnight file under the discovery-time date. Curator can set `trading_day`
  explicitly to override. Weekends / NEPSE holidays: plain calendar date; a
  non-trading day can still hold articles.
- Q4 — **LLM cost / drift** as articles-per-day grows (see NFR6).
- Q5 — **Hallucinated numbers.** Prompt constrains the model to article facts only;
  `summary_articles` + retained versions give an audit trail for "why did it say this".
- Q6 — **Production trigger.** Moving from polling to S3 Event Notifications → SQS
  needs AWS wiring; the read path and `regenerate` logic do not change.

## 12. Success criteria (demo acceptance)

1. `npm run seed:demo` (offline: watched folder + mock LLM) drops two sample
   articles for one ticker and prints a single two-paragraph summary mentioning
   both, tagged `version: 2`.
2. Against a real bucket, uploading an article JSON **through the AWS console**
   results — with no further action — in a new published summary retrievable via
   the read API within one poll interval.
3. `GET /api/stocks/{ticker}/summary` returns the fixed shape and a 404 for a
   ticker with no article today.
4. Two objects for the same ticker discovered together yield versions 1 and 2, no
   duplicate version rows, second summary reflects both articles.
5. Re-polling after no new uploads generates nothing (idempotent).
6. `npm test` is green and covers FR4, FR5, FR7, FR8, FR9.
