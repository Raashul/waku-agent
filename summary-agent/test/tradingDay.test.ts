import { describe, it, expect } from "vitest";
import { nptTradingDay } from "../src/lib/tradingDay.js";

describe("nptTradingDay", () => {
  it("returns the Kathmandu calendar date as YYYY-MM-DD", () => {
    // 2026-08-27 06:00 UTC -> 11:45 NPT, same day
    expect(nptTradingDay(new Date("2026-08-27T06:00:00Z"))).toBe("2026-08-27");
  });

  it("rolls to the next day once NPT passes midnight even though UTC has not", () => {
    // 2026-08-27 18:30 UTC -> 2026-08-28 00:15 NPT (UTC+05:45)
    expect(nptTradingDay(new Date("2026-08-27T18:30:00Z"))).toBe("2026-08-28");
  });

  it("stays on the previous day for early-UTC times that are still evening NPT", () => {
    // 2026-08-27 02:00 UTC -> 2026-08-27 07:45 NPT
    expect(nptTradingDay(new Date("2026-08-27T02:00:00Z"))).toBe("2026-08-27");
  });

  it("handles the 45-minute offset at the exact boundary", () => {
    // 2025-12-31 18:14 UTC -> 2025-12-31 23:59 NPT
    expect(nptTradingDay(new Date("2025-12-31T18:14:00Z"))).toBe("2025-12-31");
    // one minute later -> 2026-01-01 00:00 NPT
    expect(nptTradingDay(new Date("2025-12-31T18:15:00Z"))).toBe("2026-01-01");
  });
});
