import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ObjectStore, StoredObject } from "./objectStore.js";

/**
 * Real S3. Discovery is a paginated ListObjectsV2 over the prefix; the poller
 * diffs the returned keys against what it has already ingested. A console upload
 * (or `aws s3 cp`) needs no code change — the next poll picks it up.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { region?: string; endpoint?: string } = {},
  ) {
    this.client = new S3Client({
      region: opts.region || process.env.AWS_REGION || "us-east-1",
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    });
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async getObject(key: string): Promise<StoredObject> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = await res.Body!.transformToString("utf8");
    return { key, body, lastModified: res.LastModified ?? new Date() };
  }

  async putObject(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "text/markdown" }),
    );
  }
}
