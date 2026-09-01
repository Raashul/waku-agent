import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb } from "./helpers.js";
import { pool, closePool } from "../src/db/pool.js";
import * as summariesRepo from "../src/db/summariesRepo.js";
import { nptTradingDay } from "../src/lib/tradingDay.js";

async function seedPublished(
  ticker: string,
  day: string,
  version: number,
  extra: Partial<{ sentiment: string; p1: string }> = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO stock_summaries (ticker, trading_day, version, paragraph_1, paragraph_2, sentiment, model_used, status)
     VALUES ($1,$2,$3,$4,'impact para',$5,'mock','published') RETURNING id`,
    [ticker, day, version, extra.p1 ?? `event para v${version}`, extra.sentiment ?? "neutral"],
  );
  return rows[0].id as string;
}

describe("summariesRepo", () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it("nextVersion counts up per ticker+day", async () => {
    expect(await summariesRepo.nextVersion("NABIL", "2026-08-27")).toBe(1);
    await seedPublished("NABIL", "2026-08-27", 1);
    expect(await summariesRepo.nextVersion("NABIL", "2026-08-27")).toBe(2);
    expect(await summariesRepo.nextVersion("NABIL", "2026-08-26")).toBe(1);
  });

  it("getLatest prefers today's trading day", async () => {
    await seedPublished("NVDA", "2026-01-01", 1, { p1: "old" });
    await seedPublished("NVDA", nptTradingDay(), 1, { p1: "fresh" });
    const latest = await summariesRepo.getLatest("NVDA");
    expect(latest?.paragraph_1).toBe("fresh");
    expect(latest?.stale).toBe(false);
  });

  it("getLatest falls back to the newest prior day and flags it stale", async () => {
    await seedPublished("UPPER", "2026-01-01", 1, { p1: "jan" });
    await seedPublished("UPPER", "2026-02-15", 2, { p1: "feb" });
    const latest = await summariesRepo.getLatest("UPPER");
    expect(latest?.paragraph_1).toBe("feb");
    expect(latest?.trading_day).toBe("2026-02-15");
    expect(latest?.stale).toBe(true);
  });

  it("getLatest returns null when the ticker has no published summary", async () => {
    expect(await summariesRepo.getLatest("NOPE")).toBeNull();
  });

  it("listTrending returns one row per ticker, newest first", async () => {
    await seedPublished("AAA", "2026-01-01", 1);
    await new Promise((r) => setTimeout(r, 10));
    await seedPublished("BBB", "2026-01-01", 1);
    await new Promise((r) => setTimeout(r, 10));
    await seedPublished("AAA", "2026-01-02", 2);
    const trending = await summariesRepo.listTrending(10);
    expect(trending.map((t) => t.ticker)).toEqual(["AAA", "BBB"]);
    expect(trending[0]!.version).toBe(2);
  });
});
