import { config } from "./config.js";
import { migrate } from "./db/pool.js";
import { makeObjectStore } from "./storage/index.js";
import { makeLlm } from "./summarizer/llm/index.js";
import { startPoller } from "./ingest/poller.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  await migrate();

  const deps = { store: makeObjectStore(), llm: makeLlm() };
  const stopPoller = startPoller(deps);

  const app = createApp();
  const server = app.listen(config.port, () => {
    const where =
      config.storage.driver === "s3"
        ? `s3://${config.storage.s3Bucket}/${config.articlesPrefix}`
        : `${config.storage.objectDir}/${config.articlesPrefix}`;
    console.log(
      `[summary-agent] http://localhost:${config.port} · llm=${config.llm.driver} · watching ${where} every ${config.pollIntervalMs}ms`,
    );
    console.log(`[summary-agent] drop files at ${config.articlesPrefix}<TICKER>/<name>.md — each poll and detection is logged below`);
  });

  const shutdown = () => {
    stopPoller();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[summary-agent] failed to start:", err);
  process.exit(1);
});
