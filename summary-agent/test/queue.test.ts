import { describe, it, expect } from "vitest";
import { TickerQueue } from "../src/summarizer/queue.js";

describe("TickerQueue", () => {
  it("runs same-ticker jobs strictly in order", async () => {
    const q = new TickerQueue();
    const order: number[] = [];
    const mk = (n: number, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
    };
    q.enqueue("NVDA", mk(1, 30));
    q.enqueue("NVDA", mk(2, 5)); // shorter, but must still wait for job 1
    q.enqueue("NVDA", mk(3, 1));
    await q.drain();
    expect(order).toEqual([1, 2, 3]);
  });

  it("lets different tickers run concurrently", async () => {
    const q = new TickerQueue();
    const started: string[] = [];
    const mk = (t: string) => async () => {
      started.push(t);
      await new Promise((r) => setTimeout(r, 20));
    };
    q.enqueue("AAA", mk("AAA"));
    q.enqueue("BBB", mk("BBB"));
    await new Promise((r) => setTimeout(r, 5));
    expect(started.sort()).toEqual(["AAA", "BBB"]); // both started before either finished
    await q.drain();
  });

  it("a rejected job does not break the chain for the next one", async () => {
    const q = new TickerQueue();
    const done: string[] = [];
    q.enqueue("X", async () => {
      throw new Error("boom");
    }).catch(() => done.push("caught"));
    q.enqueue("X", async () => {
      done.push("second-ran");
    });
    await q.drain();
    expect(done).toContain("caught");
    expect(done).toContain("second-ran");
  });
});
