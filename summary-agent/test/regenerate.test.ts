import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb, tmpStore, mockDeps } from "./helpers.js";
import { pool, closePool } from "../src/db/pool.js";
import * as articlesRepo from "../src/db/articlesRepo.js";
import { regenerate } from "../src/summarizer/regenerate.js";
import { nptTradingDay } from "../src/lib/tradingDay.js";

const DAY = nptTradingDay();

describe("regenerate", () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it("produces v1 from one article and marks it summarized", async () => {
    const { store, dir } = await tmpStore();
    await store.putObject("articles/NVDA/a1.md", "NVDA sales jumped 106% and it beat estimates.");
    const { row } = await articlesRepo.insertIfNew({
      ticker: "NVDA",
      tradingDay: DAY,
      s3Key: "articles/NVDA/a1.md",
    });

    const res = await regenerate("NVDA", DAY, mockDeps(store));
    expect(res.status).toBe("published");
    expect(res.version).toBe(1);

    const { rows } = await pool.query(
      `SELECT * FROM stock_summaries WHERE ticker='NVDA' AND trading_day=$1`,
      [DAY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("published");
    expect(rows[0].paragraph_1.length).toBeGreaterThan(0);
    expect(rows[0].paragraph_2.length).toBeGreaterThan(0);
    expect(rows[0].sentiment).toBe("positive"); // mock detects "jumped"/"beat"

    const fresh = await pool.query(`SELECT summarized_at FROM articles WHERE id=$1`, [row.id]);
    expect(fresh.rows[0].summarized_at).not.toBeNull();

    void dir;
  });

  it("v2 re-synthesizes from BOTH of the day's articles and links them", async () => {
    const { store } = await tmpStore();
    await store.putObject("articles/NVDA/a1.md", "NVDA reported an earnings beat on Wednesday.");
    await articlesRepo.insertIfNew({ ticker: "NVDA", tradingDay: DAY, s3Key: "articles/NVDA/a1.md" });
    await regenerate("NVDA", DAY, mockDeps(store));

    await store.putObject("articles/NVDA/a2.md", "NVDA is buying Hugging Face for $12.9 billion.");
    await articlesRepo.insertIfNew({ ticker: "NVDA", tradingDay: DAY, s3Key: "articles/NVDA/a2.md" });
    const res = await regenerate("NVDA", DAY, mockDeps(store));

    expect(res.version).toBe(2);
    const summary = await pool.query(
      `SELECT * FROM stock_summaries WHERE ticker='NVDA' AND version=2`,
    );
    expect(summary.rows[0].paragraph_1).toContain("earnings beat");
    expect(summary.rows[0].paragraph_1).toContain("Hugging Face");

    const links = await pool.query(
      `SELECT COUNT(*)::int AS n FROM summary_articles WHERE summary_id=$1`,
      [summary.rows[0].id],
    );
    expect(links.rows[0].n).toBe(2);
  });

  it("skips cleanly when there are no articles for the day", async () => {
    const { store } = await tmpStore();
    const res = await regenerate("EMPTY", DAY, mockDeps(store));
    expect(res.status).toBe("skipped");
  });

  it("writes a failed row (not a crash) when the model output cannot be parsed", async () => {
    const { store } = await tmpStore();
    await store.putObject("articles/BAD/a1.md", "some article text");
    await articlesRepo.insertIfNew({ ticker: "BAD", tradingDay: DAY, s3Key: "articles/BAD/a1.md" });

    const brokenLlm = {
      name: "broken",
      async summarize() {
        return { text: "only one line, no paragraphs", model: "broken" };
      },
    };
    const res = await regenerate("BAD", DAY, { store, llm: brokenLlm });
    expect(res.status).toBe("failed");
    const { rows } = await pool.query(`SELECT status FROM stock_summaries WHERE ticker='BAD'`);
    expect(rows[0].status).toBe("failed");
  });
});
