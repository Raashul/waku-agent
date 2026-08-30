import { config } from "../config.js";
import type { ObjectStore } from "./objectStore.js";
import { FsObjectStore } from "./fsStore.js";
import { S3ObjectStore } from "./s3Store.js";

export type { ObjectStore, StoredObject } from "./objectStore.js";

export function makeObjectStore(): ObjectStore {
  if (config.storage.driver === "s3") {
    if (!config.storage.s3Bucket) throw new Error("STORAGE_DRIVER=s3 but S3_BUCKET is not set");
    return new S3ObjectStore(config.storage.s3Bucket, {
      region: config.storage.s3Region,
      endpoint: config.storage.s3Endpoint,
    });
  }
  return new FsObjectStore(config.storage.objectDir);
}
