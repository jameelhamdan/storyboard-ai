import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { WorkspacePort } from '@application/port/WorkspacePort.js';
import type { JobId } from '@domain/job/JobId.js';

/**
 * Backed by a docker-compose named volume mounted at the same path in every
 * worker. This is the local default: cheapest and fastest, and it works precisely
 * because all workers share a host.
 *
 * When workers stop sharing a filesystem, swap in ObjectStorageWorkspace — the
 * port is shaped so nothing else changes.
 */
export class SharedVolumeWorkspace implements WorkspacePort {
  private readonly root: string;

  constructor(root: string) {
    // Resolved once, here. The traversal check below compares absolute paths, so
    // a relative WORKSPACE_DIR (which docker-compose does not use but local dev
    // does) would otherwise fail every key against its own root.
    this.root = resolve(root);
  }

  public async put(jobId: JobId, key: string, data: Readable | Buffer): Promise<void> {
    const path = this.pathFor(jobId, key);
    await mkdir(dirname(path), { recursive: true });

    const source = Buffer.isBuffer(data) ? Readable.from([data]) : data;
    await pipeline(source, createWriteStream(path));
  }

  public async putFile(jobId: JobId, key: string, localPath: string): Promise<void> {
    const target = this.pathFor(jobId, key);
    if (resolve(localPath) === target) return; // already written in place
    await mkdir(dirname(target), { recursive: true });
    await copyFile(localPath, target);
  }

  public async get(jobId: JobId, key: string): Promise<Buffer> {
    return readFile(this.pathFor(jobId, key));
  }

  public async has(jobId: JobId, key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(jobId, key));
      return true;
    } catch {
      return false;
    }
  }

  public async list(jobId: JobId, prefix: string): Promise<readonly string[]> {
    const base = this.pathFor(jobId, prefix);
    try {
      const entries = await readdir(base, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => join(prefix, e.name)).sort();
    } catch {
      return [];
    }
  }

  /** Already on a real filesystem, so this is the path itself. */
  public async localCopy(jobId: JobId, key: string): Promise<string> {
    const path = this.pathFor(jobId, key);
    await stat(path); // surface a missing checkpoint here, not inside ffmpeg
    return path;
  }

  public async scratchPath(jobId: JobId, key: string): Promise<string> {
    const path = this.pathFor(jobId, key);
    await mkdir(dirname(path), { recursive: true });
    return path;
  }

  public async discard(jobId: JobId): Promise<void> {
    await rm(this.jobRoot(jobId), { recursive: true, force: true });
  }

  /**
   * Sweeps workspaces whose worker died after the final stage, so nothing is left
   * to fill the volume. Called on a timer by the worker entrypoint.
   */
  public async sweepOrphans(olderThanSeconds: number): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - olderThanSeconds * 1000;

    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.root, entry.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // Raced with another sweeper or the owning worker; either is fine.
      }
    }
    return removed;
  }

  private jobRoot(jobId: JobId): string {
    return join(this.root, jobId.value);
  }

  /** Keys are internal, but a traversal here would escape the volume entirely. */
  private pathFor(jobId: JobId, key: string): string {
    const base = this.jobRoot(jobId);
    const path = resolve(base, key);
    if (path !== base && !path.startsWith(base + sep)) {
      throw new Error(`Workspace key '${key}' escapes the job directory.`);
    }
    return path;
  }
}
