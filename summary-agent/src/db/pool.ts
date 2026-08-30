import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Keep DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects —
// trading_day is a calendar date, never a moment in time, and must not be
// reinterpreted through the process timezone.
pg.types.setTypeParser(1082, (v) => v);

// One pool per process. Tests import this same module, so they share it.
export const pool = new pg.Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  max: 8,
});

let migrated = false;

export async function migrate(): Promise<void> {
  if (migrated) return;
  const sql = readFileSync(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
  migrated = true;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
