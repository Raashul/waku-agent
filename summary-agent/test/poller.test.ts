import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb, tmpStore, mockDeps } from "./helpers.js";
import { pool, closePool } from "../src/db/pool.js";
import { tick } from "../src/ingest/poller.js";
import { tickerQueue } from "../src/summarizer/queue.js";
import { nptTradingDay } from "../src/lib/tradingDay.js";

const DAY = nptTradingDay();

async function versionCount(ticker: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM stock_summaries WHERE ticker = $1`,
    [ticker],
  );
  return rows[0]!.n;
}

describe("poller", () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it("ingests a new key exactly once across repeated ticks", async () => {
    const { store } = await tmpStore();
    await store.putObject("articles/NVDA/a1.md", "NVDA jumped 8% on an earnings beat.");

    const r1 = await tick(mockDeps(store));
    expect(r1.newKeys).toBe(1);
    await tickerQueue.drain();

    // Several more steady-state passes with nothing new must not pile on versions.
    for (let i = 0; i < 4; i++) {
      const r = await tick(mockDeps(store));
      expect(r.newKeys).toBe(0);
      expect(r.enqueued).toBe(0);
      expect(r.redriven).toBe(0);
      await tickerQueue.drain();
    }
    expect(await versionCount("NVDA")).toBe(1);
  });

  it("does not re-drive an article while its regeneration is in flight", async () => {
    const { store } = await tmpStore();
    await store.putObject("articles/NABIL/a1.md", "NABIL rose 3% after strong profit.");

    // A slow LLM keeps the 'generating' row open across the next tick.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowLlm = {
      name: "slow",
      async summarize() {
        await gate;
        return { text: "Event para about NABIL.\n\nImpact para.\n\nSentiment: Positive", model: "slow" };
      },
    };
    const deps = { store, llm: slowLlm };

    await tick(deps); // enqueues regenerate; job now awaits the gate
    // Steady-state tick while the job is mid-flight -> must see the 'generating'
    // row and not enqueue a duplicate.
    const mid = await tick(deps);
    expect(mid.redriven).toBe(0);

    release();
    await tickerQueue.drain();
    expect(await versionCount("NABIL")).toBe(1);
  });

  it("skips historical trading days unless BACKFILL is set", async () => {
    const { store } = await tmpStore();
    // Force an old mtime so trading_day resolves to the past.
    await store.putObject("articles/OLD/a1.md", "OLD news from long ago.");
    const fs = await import("node:fs");
    const oldDate = new Date("2025-01-02T00:00:00Z");
    fs.utimesSync(`${(store as any).root}/articles/OLD/a1.md`, oldDate, oldDate);

    const r = await tick(mockDeps(store));
    expect(r.enqueued).toBe(0);
    await tickerQueue.drain();
    expect(await versionCount("OLD")).toBe(0);
    void DAY;
  });
});
