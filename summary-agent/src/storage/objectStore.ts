export interface StoredObject {
  key: string;
  body: string;
  lastModified: Date;
}

export interface ObjectStore {
  /** All object keys under a prefix, e.g. "articles/". */
  listKeys(prefix: string): Promise<string[]>;
  getObject(key: string): Promise<StoredObject>;
  /** Used by the seed script / tests to stand in for a console upload. */
  putObject(key: string, body: string): Promise<void>;
}
