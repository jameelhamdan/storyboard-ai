import { mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectStoragePort, StoredObject } from '@application/port/ObjectStoragePort.js';

/**
 * Local filesystem, served over HTTP by the API. The default while there is no
 * deployment target (plan.md §1) — S3ObjectStorage is the same port, so the swap
 * is a container binding.
 */
export class LocalObjectStorage implements ObjectStoragePort {
  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
  ) {}

  public async put(input: { key: string; localPath: string; contentType: string }): Promise<StoredObject> {
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(input.localPath, target);
    const info = await stat(target);
    return {
      key: input.key,
      url: `${this.publicBaseUrl.replace(/\/$/, '')}/${input.key}`,
      sizeBytes: info.size,
    };
  }

  /**
   * There is nothing to sign locally, so this returns the plain URL. The API
   * contract's expiry promise is therefore only true on S3/R2 — which is fine
   * while "local only" is the stated scope, and is why the driver is a config
   * choice rather than a code path anyone has to remember to change.
   */
  public async presignedUrl(key: string): Promise<string> {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  private pathFor(key: string): string {
    const base = resolve(this.root);
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw new Error(`Storage key '${key}' escapes the storage root.`);
    return path;
  }

}
