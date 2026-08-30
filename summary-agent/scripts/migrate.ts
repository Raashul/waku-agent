import { migrate, closePool } from "../src/db/pool.js";

migrate()
  .then(() => {
    console.log("schema up to date");
    return closePool();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
