export interface StoredObject {
  readonly key: string;
  readonly url: string;
  readonly sizeBytes: number;
}

export interface ObjectStoragePort {
  put(input: {
    key: string;
    localPath: string;
    contentType: string;
  }): Promise<StoredObject>;

  /** Presigned and expiring — the API never hands out a permanent public URL. */
  presignedUrl(key: string, ttlSeconds: number): Promise<string>;
}
