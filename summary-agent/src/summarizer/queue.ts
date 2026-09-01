/**
 * Per-ticker serialization. Jobs for the same ticker run one at a time and in
 * order; different tickers run concurrently. This is the in-process stand-in for
 * SQS FIFO with MessageGroupId = ticker — it guarantees v1 is written before v2
 * when two articles for one ticker land seconds apart.
 */
export class TickerQueue {
  private chains = new Map<string, Promise<unknown>>();
  private depth = new Map<string, number>();

  enqueue<T>(ticker: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(ticker) ?? Promise.resolve();
    this.depth.set(ticker, (this.depth.get(ticker) ?? 0) + 1);

    const run = prev.then(job, job); // run regardless of whether the prior job rejected

    // The chain handed to the next job must never reject.
    const tail: Promise<unknown> = run.catch(() => undefined).then(() => {
      const left = (this.depth.get(ticker) ?? 1) - 1;
      if (left <= 0) {
        this.depth.delete(ticker);
        if (this.chains.get(ticker) === tail) this.chains.delete(ticker);
      } else {
        this.depth.set(ticker, left);
      }
    });
    this.chains.set(ticker, tail);

    return run;
  }

  /** True while a job for this ticker is queued or running. */
  has(ticker: string): boolean {
    return (this.depth.get(ticker) ?? 0) > 0;
  }

  /** Resolves when every currently-queued job has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }
}

export const tickerQueue = new TickerQueue();
