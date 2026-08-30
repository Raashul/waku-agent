# summary-agent

Nepal Stock Cortex — demo tier. A standalone Node.js + TypeScript service that
watches an S3 bucket for uploaded news articles, LLM-summarizes each one per
ticker per NEPSE trading day (versioned), and serves the result to a read API the
market/company pages call.

Design docs: [`requirement.md`](./requirement.md), [`plan.md`](./plan.md).
Concept + review: `../.lavish/nepal-stock-cortex*.html`, `../.lavish/grill-summary-agent.html`.

## How it works

```
curator drops  articles/<TICKER>/<name>.md   (AWS console, or a folder in dev)
       │
       ▼
poller  (ListObjectsV2 every POLL_INTERVAL_MS + one scan at startup)
       │  new key?  -> record article row, enqueue regenerate(<TICKER>, <trading_day>)
       ▼
regenerate   load ALL of that ticker's articles for the trading day
       │     -> LLM  -> parse to { paragraph_1, paragraph_2, sentiment }
       │     -> INSERT stock_summaries (version = max+1, status=published)
       ▼
GET /api/stocks/<TICKER>/summary   latest published version (falls back to the
                                   most recent prior day, flagged `stale`)
```

- **The object key carries the ticker.** Body is raw article text (`.md` / `.txt`) —
  no JSON to hand-author. `trading_day` is the Kathmandu (UTC+05:45) calendar date
  at discovery, stored, never re-derived from UTC.
- **A console upload does not call this service.** Discovery is by polling; the
  S3-event → SQS path is the production upgrade and leaves `regenerate` unchanged.
- **Crash-safe.** An article row carries `summarized_at`; the first poll after a
  restart re-drives anything ingested but never summarized. A `generating` row is
  the in-flight marker so steady-state polls don't double-run.
- **Idempotent.** `s3_key` is unique; re-polling with nothing new is a no-op;
  `regenerate` skips when every article for the day is already in a published version.

## Run

Prereqs: Node 20+, a Postgres. The dev Postgres runs in Docker (host 5432 is taken
by a native install):

```bash
docker run -d --name summary-agent-pg \
  -e POSTGRES_USER=root -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=moneymoney-ai-summary -p 55432:5432 postgres:15

npm install
npm start          # migrates, starts the poller + HTTP server on :8088
```

Config is `.env` (this dir), with `OPENROUTER_API_KEY` read from `../.env` as a
fallback. Key vars:

| var | default | note |
| --- | --- | --- |
| `STORAGE_DRIVER` | `fs` | `fs` watches `OBJECT_DIR`; `s3` needs `S3_BUCKET` |
| `OBJECT_DIR` | `.data/objects` | the fake bucket in `fs` mode |
| `ARTICLES_PREFIX` | `articles/` | keys are `articles/<TICKER>/<name>.md` |
| `POLL_INTERVAL_MS` | `5000` | discovery latency |
| `LLM_DRIVER` | `openrouter` | `mock` = deterministic, no network |
| `LLM_MODEL` | `anthropic/claude-haiku-4.5` | OpenRouter slug |
| `BACKFILL` | `false` | also summarize trading days before today |

### Try it

```bash
# offline, deterministic — uploads docs/<TICKER>/*.md and prints the summary
LLM_DRIVER=mock npm run seed:demo

# against the running server (fs mode): "upload" by dropping a file
mkdir -p .data/objects/articles/NVDA
cp docs/NVDA/article1.md .data/objects/articles/NVDA/article1.md
sleep 6
curl -s localhost:8088/api/stocks/NVDA/summary | jq
```

## API

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/stocks/:ticker/summary` | latest published summary; `stale=true` when it's from a prior day |
| GET | `/api/stocks/:ticker/summary/history?day=YYYY-MM-DD` | all versions for a ticker/day |
| GET | `/api/market/summaries?limit=N` | most recent summary per ticker |
| GET | `/api/health` | active drivers + last poll report |

`GET /api/stocks/NVDA/summary` →

```json
{
  "ticker": "NVDA", "trading_day": "2026-08-28", "version": 2,
  "paragraph_1": "...", "paragraph_2": "...",
  "sentiment": "positive", "model_used": "anthropic/claude-haiku-4.5",
  "generated_at": "2026-08-27T21:33:33.078Z", "article_count": 2, "stale": false
}
```

## Test

```bash
npm test          # vitest; integration tests need the Postgres above
npm run typecheck
```

The LLM integration tests (`test/llm.integration.test.ts`) hit OpenRouter for real
and skip automatically when no `OPENROUTER_API_KEY` is available. Everything else
uses the `fs` store + a deterministic mock model.

## Not built here (see `plan.md` M4)

Admin auth + an upload UI, the S3-event → SQS FIFO trigger, a Postgres migration
tool, a real scraper. The schema and `regenerate` are already shaped for all four.
