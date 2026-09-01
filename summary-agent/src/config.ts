import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Load this service's own .env first, then fall back to the waku-agent root .env
// for shared secrets (OPENROUTER_API_KEY) so the key lives in exactly one place.
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.resolve(root, "..", ".env") });

const env = process.env;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  return /^(1|true|yes)$/i.test(v.trim());
}

export interface Config {
  port: number;
  tradingTz: string;
  backfill: boolean;
  pollIntervalMs: number;
  articlesPrefix: string;
  storage: { driver: "fs" | "s3"; objectDir: string; s3Bucket?: string; s3Region?: string; s3Endpoint?: string };
  llm: { driver: "mock" | "openrouter"; model: string; baseUrl: string; apiKey?: string };
  pg: { host: string; port: number; user: string; password: string; database: string };
}

export function loadConfig(): Config {
  const llmDriver = (env.LLM_DRIVER || "mock").toLowerCase() as "mock" | "openrouter";
  const apiKey = env.OPENROUTER_API_KEY || env.LLM_API_KEY;

  return {
    port: Number(env.PORT || 8088),
    tradingTz: env.TRADING_TZ || "Asia/Kathmandu",
    backfill: bool(env.BACKFILL, false),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 5000),
    articlesPrefix: env.ARTICLES_PREFIX || "articles/",
    storage: {
      driver: (env.STORAGE_DRIVER || "fs").toLowerCase() === "s3" ? "s3" : "fs",
      objectDir: path.isAbsolute(env.OBJECT_DIR || "")
        ? (env.OBJECT_DIR as string)
        : path.join(root, env.OBJECT_DIR || ".data/objects"),
      s3Bucket: env.S3_BUCKET,
      s3Region: env.S3_REGION,
      s3Endpoint: env.S3_ENDPOINT,
    },
    llm: {
      // Fall back to mock if openrouter is asked for but no key is present, so
      // a fresh clone still boots.
      driver: llmDriver === "openrouter" && !apiKey ? "mock" : llmDriver,
      model: env.LLM_MODEL || "anthropic/claude-haiku-4.5",
      baseUrl: env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey,
    },
    pg: {
      host: env.POSTGRES_HOST || "localhost",
      port: Number(env.POSTGRES_PORT || 5432),
      user: env.POSTGRES_USER || "postgres",
      password: env.POSTGRES_PWD || env.POSTGRES_PASSWORD || "",
      database: env.POSTGRES_DATABASE || "postgres",
    },
  };
}

export const config = loadConfig();
