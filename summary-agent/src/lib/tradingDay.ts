// The NEPSE trading day is a Kathmandu (NPT, UTC+05:45) calendar date. It is
// computed once, at discovery time, and then stored — never re-derived from a
// UTC timestamp at query time, which would misfile anything uploaded near
// midnight NPT.

const TZ = process.env.TRADING_TZ || "Asia/Kathmandu";

// en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function nptTradingDay(when: Date = new Date()): string {
  return fmt.format(when);
}
