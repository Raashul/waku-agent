import { promises as fs } from "node:fs";
import path from "node:path";
import type { ObjectStore, StoredObject } from "./objectStore.js";

/**
 * A local directory that behaves like an S3 bucket: keys are POSIX-style paths
 * relative to the root. Used for the offline demo and every test — the poller
 * cannot tell it apart from the real S3 store.
 */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private full(key: string): string {
    return path.join(this.root, key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const base = path.join(this.root, prefix);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        if (e?.code === "ENOENT") return;
        throw e;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile()) out.push(p);
      }
    }
    await walk(base);
    return out.map((p) => path.relative(this.root, p).split(path.sep).join("/")).sort();
  }

  async getObject(key: string): Promise<StoredObject> {
    const full = this.full(key);
    const [body, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
    return { key, body, lastModified: stat.mtime };
  }

  async putObject(key: string, body: string): Promise<void> {
    const full = this.full(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
    // Ensure a fresh mtime even if the file already existed.
    const now = new Date();
    await fs.utimes(full, now, now);
  }
}
