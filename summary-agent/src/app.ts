import express from "express";
import { config } from "./config.js";
import { nptTradingDay } from "./lib/tradingDay.js";
import * as summariesRepo from "./db/summariesRepo.js";
import { lastTickReport } from "./ingest/poller.js";

const TICKER_RE = /^[A-Za-z]{2,10}$/;

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // CORS: this is public read content consumed by the money-mitra-demo frontend.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      storage: config.storage.driver,
      llm: config.llm.driver,
      trading_day: nptTradingDay(),
      last_poll: lastTickReport(),
    });
  });

  // Latest published summary for a ticker. Falls back to the most recent
  // summary from any day when today has none (stale=true).
  app.get("/api/stocks/:ticker/summary", async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: "bad ticker" });
    const latest = await summariesRepo.getLatest(ticker);
    if (!latest) return res.status(404).json({ error: `no summary for ${ticker}` });
    res.json({
      ticker: latest.ticker,
      trading_day: latest.trading_day,
      version: latest.version,
      paragraph_1: latest.paragraph_1,
      paragraph_2: latest.paragraph_2,
      sentiment: latest.sentiment,
      model_used: latest.model_used,
      generated_at: latest.generated_at,
      article_count: latest.article_count,
      stale: latest.stale,
    });
  });

  app.get("/api/stocks/:ticker/summary/history", async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: "bad ticker" });
    const day = typeof req.query.day === "string" ? req.query.day : nptTradingDay();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "bad day" });
    const versions = await summariesRepo.getHistory(ticker, day);
    res.json({ ticker, day, versions });
  });

  app.get("/api/market/summaries", async (req, res) => {
    const raw = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 50) : 10;
    res.json({ items: await summariesRepo.listTrending(limit) });
  });

  return app;
}
