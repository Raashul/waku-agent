/**
 * Offline end-to-end demo. Copies the sample article(s) under docs/<TICKER>/ into
 * the object store as if a curator had uploaded them to S3, runs one poller
 * pass, waits for the summary, and prints what the read API would return.
 *
 *   npm run seed:demo
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { migrate, closePool } from "../src/db/pool.js";
import { makeObjectStore } from "../src/storage/index.js";
import { makeLlm } from "../src/summarizer/llm/index.js";
import { tick } from "../src/ingest/poller.js";
import { tickerQueue } from "../src/summarizer/queue.js";
import * as summariesRepo from "../src/db/summariesRepo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "..", "docs");

async function main(): Promise<void> {
  await migrate();
  const store = makeObjectStore();
  const llm = makeLlm();
  console.log(`storage=${config.storage.driver}  llm=${llm.name}  db=${config.pg.database}`);

  // docs/<TICKER>/<file>.md  ->  articles/<TICKER>/<run>-<file>.md
  // A fresh run id per invocation keeps the demo repeatable: every run is a new
  // object, so it always ingests and bumps the version rather than no-opping.
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const tickers = await fs.readdir(docsDir, { withFileTypes: true });
  const uploaded: string[] = [];
  for (const t of tickers) {
    if (!t.isDirectory()) continue;
    const files = await fs.readdir(path.join(docsDir, t.name));
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      const body = await fs.readFile(path.join(docsDir, t.name, f), "utf8");
      const key = `${config.articlesPrefix}${t.name}/${runId}-${f}`;
      await store.putObject(key, body);
      uploaded.push(key);
    }
  }
  console.log(`uploaded ${uploaded.length} object(s):`, uploaded);

  const report = await tick({ store, llm });
  console.log("poller:", report);
  await tickerQueue.drain();

  for (const t of tickers) {
    if (!t.isDirectory()) continue;
    const latest = await summariesRepo.getLatest(t.name.toUpperCase());
    console.log(`\n=== ${t.name.toUpperCase()} ===`);
    if (!latest) {
      console.log("(no summary)");
      continue;
    }
    console.log(`v${latest.version}  ${latest.trading_day}  sentiment=${latest.sentiment}  model=${latest.model_used}  articles=${latest.article_count}`);
    console.log(latest.paragraph_1);
    console.log();
    console.log(latest.paragraph_2);
  }

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
