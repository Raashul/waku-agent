import { config } from "../config.js";
import { nptTradingDay } from "../lib/tradingDay.js";
import * as articlesRepo from "../db/articlesRepo.js";
import { pool } from "../db/pool.js";
import { tickerQueue } from "../summarizer/queue.js";
import { regenerate } from "../summarizer/regenerate.js";
import { ingestObject } from "./ingestObject.js";
import { log, logError, QUIET_POLLS } from "../lib/log.js";
import type { RegenerateDeps } from "../summarizer/regenerate.js";

const SKIP_REASON: Record<string, string> = {
  "skipped-key": "key is not articles/<TICKER>/<file>.md|txt",
  "skipped-empty": "object body is empty",
  "skipped-old": "trading_day is before today (set BACKFILL=true to include)",
  "already-done": "already summarized",
};

export interface TickReport {
  listed: number;
  newKeys: number;
  enqueued: number;
  redriven: number;
  at: string;
}

export interface TickOptions {
  /**
   * Re-drive articles that were ingested but never summarized. Meant for the
   * first pass after (re)start — during steady-state the in-process queue
   * guarantees delivery, so this only picks up rows left by a crash. Even with
   * this off, a `generating` row older than STALE_MINUTES is still retried.
   */
  recover?: boolean;
}

const STALE_MINUTES = 10;

let lastTick: TickReport | null = null;
export function lastTickReport(): TickReport | null {
  return lastTick;
}

/**
 * One discovery pass:
 *  1. list the prefix, ingest any key we've never seen;
 *  2. optionally re-drive stuck articles (see TickOptions.recover).
 */
export async function tick(deps: RegenerateDeps, opts: TickOptions = {}): Promise<TickReport> {
  const keys = await deps.store.listKeys(config.articlesPrefix);
  const known = await articlesRepo.knownKeys();
  const newKeys = keys.filter((k) => !known.has(k));

  let enqueued = 0;
  const handled = new Set<string>(); // ticker::day groups already enqueued this tick
  for (const key of newKeys) {
    const out = await ingestObject(key, deps);
    if (out.status === "enqueued") {
      enqueued++;
      handled.add(`${out.ticker}::${out.tradingDay}`);
      log(`[ingest] new object ${key} -> ${out.ticker} ${out.tradingDay} (queued for summary)`);
    } else {
      log(`[ingest] skipped ${key}: ${SKIP_REASON[out.status] ?? out.status}`);
    }
  }

  let redriven = 0;
  if (opts.recover) {
    redriven = await redriveStuck(deps, handled, { staleOnly: false });
  } else {
    redriven = await redriveStuck(deps, handled, { staleOnly: true });
  }

  lastTick = {
    listed: keys.length,
    newKeys: newKeys.length,
    enqueued,
    redriven,
    at: new Date().toISOString(),
  };

  const quiet = QUIET_POLLS && newKeys.length === 0 && redriven === 0;
  if (!quiet) {
    log(
      `[poll] ${config.articlesPrefix} -> ${keys.length} object(s), ${newKeys.length} new, ${enqueued} queued` +
        (redriven ? `, ${redriven} re-driven` : ""),
    );
  }
  return lastTick;
}

/**
 * Re-enqueue regeneration for (ticker, trading_day) groups that have an article
 * with no summary. `staleOnly` restricts this to groups whose newest summary row
 * is stuck in `generating` past STALE_MINUTES — i.e. a genuinely dead job, not
 * one the queue is about to run.
 */
async function redriveStuck(
  deps: RegenerateDeps,
  skip: Set<string>,
  { staleOnly }: { staleOnly: boolean },
): Promise<number> {
  const pending = await articlesRepo.pendingArticles();
  if (pending.length === 0) return 0;

  const today = nptTradingDay();
  let count = 0;
  const seen = new Set(skip);

  for (const a of pending) {
    const groupKey = `${a.ticker}::${a.trading_day}`;
    if (seen.has(groupKey)) continue;
    if (!config.backfill && a.trading_day < today) continue;
    // A job for this ticker is already queued or running in this process.
    if (tickerQueue.has(a.ticker)) {
      seen.add(groupKey);
      continue;
    }

    if (staleOnly) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM stock_summaries
          WHERE ticker = $1 AND trading_day = $2
            AND (status <> 'generating' OR generated_at > now() - ($3 || ' minutes')::interval)`,
        [a.ticker, a.trading_day, String(STALE_MINUTES)],
      );
      // A recent/terminal row exists -> a job ran or is running; leave it alone.
      if ((rows[0]?.n ?? 0) > 0) {
        seen.add(groupKey);
        continue;
      }
    }

    seen.add(groupKey);
    log(`[ingest] re-driving ${a.ticker} ${a.trading_day} (article had no summary)`);
    tickerQueue.enqueue(a.ticker, () => regenerate(a.ticker, a.trading_day, deps));
    count++;
  }
  return count;
}

export function startPoller(deps: RegenerateDeps): () => void {
  let stopped = false;
  let first = true;
  const loop = async () => {
    if (stopped) return;
    try {
      await tick(deps, { recover: first });
    } catch (err) {
      logError(`[poll] tick failed: ${err instanceof Error ? err.message : err}`);
    }
    first = false;
    if (!stopped) timer = setTimeout(loop, config.pollIntervalMs);
  };
  let timer: NodeJS.Timeout = setTimeout(loop, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
