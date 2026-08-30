import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { resetDb, tmpStore } from "./helpers.js";
import { closePool } from "../src/db/pool.js";
import { config } from "../src/config.js";
import { OpenRouterLlm } from "../src/summarizer/llm/openrouter.js";
import { tick } from "../src/ingest/poller.js";
import { tickerQueue } from "../src/summarizer/queue.js";
import { createApp } from "../src/app.js";
import { parseSummary } from "../src/summarizer/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NVDA_ARTICLE = readFileSync(path.resolve(here, "..", "docs", "NVDA", "article1.md"), "utf8");

const hasKey = Boolean(config.llm.apiKey);

// Real network + real model. Skipped automatically when no OPENROUTER_API_KEY is
// available (fresh clone / CI without secrets).
describe.skipIf(!hasKey)("LLM integration (OpenRouter, real model)", () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it("summarizes the real NVDA article into the fixed two-paragraph shape", async () => {
    const llm = new OpenRouterLlm(config.llm.model, config.llm.apiKey!, config.llm.baseUrl);
    const raw = await llm.summarize({ ticker: "NVDA", articles: [NVDA_ARTICLE] });
    expect(raw.text.length).toBeGreaterThan(80);

    const parsed = parseSummary(raw.text);
    expect(parsed.paragraph_1.length).toBeGreaterThan(20);
    expect(parsed.paragraph_2.length).toBeGreaterThan(20);
    expect(["positive", "negative", "neutral"]).toContain(parsed.sentiment);
    // Grounded in the article — one of these numbers should survive.
    expect(parsed.paragraph_1 + parsed.paragraph_2).toMatch(/NVDA|Nvidia/);
  }, 60_000);

  it("runs the full upload -> poller -> read API path with the real model", async () => {
    const { store } = await tmpStore();
    const app = createApp();
    const llm = new OpenRouterLlm(config.llm.model, config.llm.apiKey!, config.llm.baseUrl);

    await store.putObject("articles/NVDA/article1.md", NVDA_ARTICLE);
    const report = await tick({ store, llm });
    expect(report.enqueued).toBe(1);
    await tickerQueue.drain();

    const res = await request(app).get("/api/stocks/NVDA/summary").expect(200);
    expect(res.body.version).toBe(1);
    expect(res.body.model_used).toContain("claude");
    expect(res.body.paragraph_1.length).toBeGreaterThan(20);
    expect(res.body.paragraph_2.length).toBeGreaterThan(20);
  }, 60_000);
});
