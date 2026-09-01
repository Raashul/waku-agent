/**
 * Upload one article to the configured object store (fs or s3) — the same thing
 * a curator does by dropping a file in the S3 console.
 *
 *   tsx scripts/put-article.ts docs/NVDA/article1.md          # ticker from parent dir
 *   tsx scripts/put-article.ts path/to/story.md NVDA          # explicit ticker
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { makeObjectStore } from "../src/storage/index.js";

async function main(): Promise<void> {
  const file = process.argv[2] || process.env.FILE;
  if (!file) {
    console.error("usage: tsx scripts/put-article.ts <file.md> [TICKER]");
    process.exit(2);
  }
  const abs = path.resolve(file);
  const ticker = (
    process.argv[3] ||
    process.env.TICKER ||
    path.basename(path.dirname(abs))
  ).toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(ticker)) {
    console.error(`bad ticker "${ticker}" — pass one explicitly: tsx scripts/put-article.ts ${file} SYM`);
    process.exit(2);
  }

  const key = `${config.articlesPrefix}${ticker}/${path.basename(abs)}`;
  const body = readFileSync(abs, "utf8");
  await makeObjectStore().putObject(key, body);

  const where =
    config.storage.driver === "s3" ? `s3://${config.storage.s3Bucket}/${key}` : `${config.storage.objectDir}/${key}`;
  console.log(`put ${key}  ->  ${where}  (${body.length} bytes)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
