import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { JobId } from '@domain/job/JobId.js';

describe('SharedVolumeWorkspace', () => {
  let root: string;
  const jobId = JobId.generate();

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scgen-ws-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('round-trips a buffer', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await workspace.put(jobId, 'checkpoints/00-validate.json', Buffer.from('{"ok":true}'));

    expect(await workspace.has(jobId, 'checkpoints/00-validate.json')).toBe(true);
    expect((await workspace.get(jobId, 'checkpoints/00-validate.json')).toString()).toBe('{"ok":true}');
  });

  it('reports a missing key rather than throwing on has()', async () => {
    expect(await new SharedVolumeWorkspace(root).has(jobId, 'nope.json')).toBe(false);
  });

  /**
   * Regression: the traversal guard compared a resolved absolute path against an
   * unresolved root, so a relative WORKSPACE_DIR rejected every legitimate key as
   * an escape attempt. Docker mounts an absolute path; local dev does not.
   */
  it('works with a relative root', async () => {
    const workspace = new SharedVolumeWorkspace(relative(process.cwd(), root));
    await expect(workspace.put(jobId, 'submission.json', Buffer.from('{}'))).resolves.not.toThrow();
    expect(await workspace.has(jobId, 'submission.json')).toBe(true);
  });

  it('still refuses a key that escapes the job directory', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await expect(workspace.put(jobId, '../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/escapes/);
    await expect(workspace.get(jobId, '../other-job/secret.json')).rejects.toThrow(/escapes/);
  });

  it('isolates jobs from each other', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    const other = JobId.generate();

    await workspace.put(jobId, 'k.json', Buffer.from('mine'));
    expect(await workspace.has(other, 'k.json')).toBe(false);
  });

  it('discards everything for a job, so 20 concurrent renders cannot fill the volume', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await workspace.put(jobId, 'a/b/c.json', Buffer.from('x'));

    await workspace.discard(jobId);
    expect(await workspace.has(jobId, 'a/b/c.json')).toBe(false);
  });

  it('lists a prefix', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await workspace.put(jobId, 'segments/seg-001.mp4', Buffer.from('a'));
    await workspace.put(jobId, 'segments/seg-002.mp4', Buffer.from('b'));

    expect(await workspace.list(jobId, 'segments')).toEqual([
      'segments/seg-001.mp4', 'segments/seg-002.mp4',
    ]);
  });

  it('materialises a real path for ffmpeg, and fails loudly if the key is absent', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await workspace.put(jobId, 'video.mp4', Buffer.from('binary'));

    expect(await readFile(await workspace.localCopy(jobId, 'video.mp4'), 'utf8')).toBe('binary');
    await expect(workspace.localCopy(jobId, 'missing.mp4')).rejects.toThrow();
  });

  it('sweeps orphans left by a worker that died after its final stage', async () => {
    const workspace = new SharedVolumeWorkspace(root);
    await workspace.put(jobId, 'k.json', Buffer.from('x'));

    expect(await workspace.sweepOrphans(3600)).toBe(0);   // too recent
    expect(await workspace.sweepOrphans(-1)).toBe(1);      // past its lifetime
    expect(await workspace.has(jobId, 'k.json')).toBe(false);
  });
});
