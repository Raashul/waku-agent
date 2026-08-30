import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { resetDb, tmpStore, mockDeps } from "./helpers.js";
import { closePool } from "../src/db/pool.js";
import { tick } from "../src/ingest/poller.js";
import { tickerQueue } from "../src/summarizer/queue.js";
import { createApp } from "../src/app.js";
import { nptTradingDay } from "../src/lib/tradingDay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NVDA_ARTICLE = readFileSync(
  path.resolve(here, "..", "docs", "NVDA", "article1.md"),
  "utf8",
);

/**
 * The whole workflow, end to end, with S3 mocked by a local folder and the LLM
 * mocked: drop an object -> poller detects it -> summary lands in Postgres ->
 * the read API serves it to the frontend.
 */
describe("workflow: upload -> poller -> summary -> read API", () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it("summarizes a freshly uploaded article and serves it", async () => {
    const { store } = await tmpStore();
    const app = createApp();

    // 1. "Upload to S3" — a curator drops the NVDA article into its folder.
    await store.putObject("articles/NVDA/article1.md", NVDA_ARTICLE);

    // 2. The poller's next pass detects the new object.
    const report = await tick(mockDeps(store));
    expect(report.newKeys).toBe(1);
    expect(report.enqueued).toBe(1);

    // 3. Let the queued regeneration finish.
    await tickerQueue.drain();

    // 4. The read API the market page calls now returns an analysis.
    const res = await request(app).get("/api/stocks/NVDA/summary").expect(200);
    expect(res.body.ticker).toBe("NVDA");
    expect(res.body.trading_day).toBe(nptTradingDay());
    expect(res.body.version).toBe(1);
    expect(res.body.paragraph_1.length).toBeGreaterThan(10);
    expect(res.body.paragraph_2.length).toBeGreaterThan(10);
    expect(["positive", "negative", "neutral"]).toContain(res.body.sentiment);
    expect(res.body.article_count).toBe(1);
    expect(res.body.stale).toBe(false);
    expect(typeof res.body.generated_at).toBe("string");
  });

  it("a second article the same day regenerates to v2 from both", async () => {
    const { store } = await tmpStore();
    const app = createApp();

    await store.putObject("articles/NVDA/article1.md", NVDA_ARTICLE);
    await tick(mockDeps(store));
    await tickerQueue.drain();

    await store.putObject(
      "articles/NVDA/article2.md",
      "NVDA also announced a new $40 billion buyback and a stock split effective next month.",
    );
    const report = await tick(mockDeps(store));
    expect(report.newKeys).toBe(1);
    await tickerQueue.drain();

    const res = await request(app).get("/api/stocks/NVDA/summary").expect(200);
    expect(res.body.version).toBe(2);
    expect(res.body.article_count).toBe(2);
    expect(res.body.paragraph_1).toMatch(/buyback|split/i);

    const hist = await request(app)
      .get(`/api/stocks/NVDA/summary/history?day=${nptTradingDay()}`)
      .expect(200);
    expect(hist.body.versions).toHaveLength(2);
  });

  it("re-running the poller with no new uploads is a no-op", async () => {
    const { store } = await tmpStore();
    await store.putObject("articles/NVDA/article1.md", NVDA_ARTICLE);
    await tick(mockDeps(store));
    await tickerQueue.drain();

    const second = await tick(mockDeps(store));
    expect(second.newKeys).toBe(0);
    expect(second.enqueued).toBe(0);
    expect(second.redriven).toBe(0);
  });

  it("crash recovery: an ingested-but-unsummarized article is re-driven next tick", async () => {
    const { store } = await tmpStore();
    const app = createApp();
    await store.putObject("articles/NABIL/a1.md", "NABIL rose 3% after strong quarterly profit.");

    // Simulate a crash between ingest and summary: insert the article row, but
    // never run its regeneration.
    const { insertIfNew } = await import("../src/db/articlesRepo.js");
    await insertIfNew({
      ticker: "NABIL",
      tradingDay: nptTradingDay(),
      s3Key: "articles/NABIL/a1.md",
    });

    const report = await tick(mockDeps(store), { recover: true });
    expect(report.newKeys).toBe(0); // key already known
    expect(report.redriven).toBe(1); // ...but it had no summary
    await tickerQueue.drain();

    const res = await request(app).get("/api/stocks/NABIL/summary").expect(200);
    expect(res.body.version).toBe(1);
  });

  it("unknown ticker -> 404", async () => {
    const app = createApp();
    await request(app).get("/api/stocks/ZZZZ/summary").expect(404);
  });

  it("health reports the active drivers", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.storage).toBe("fs");
    expect(res.body.trading_day).toBe(nptTradingDay());
  });
});
