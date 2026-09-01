import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pool, migrate } from "../src/db/pool.js";
import { FsObjectStore } from "../src/storage/fsStore.js";
import { MockLlm } from "../src/summarizer/llm/mock.js";

export async function resetDb(): Promise<void> {
  await migrate();
  await pool.query("TRUNCATE summary_articles, stock_summaries, articles RESTART IDENTITY CASCADE");
}

export async function tmpStore(): Promise<{ store: FsObjectStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-agent-"));
  return { store: new FsObjectStore(dir), dir };
}

export function mockDeps(store: FsObjectStore) {
  return { store, llm: new MockLlm() };
}
