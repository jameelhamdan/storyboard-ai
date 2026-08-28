import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifacts } from '@application/pipeline/stage/RunArtifacts.js';
import type { PipelineContext } from '@application/pipeline/PipelineContext.js';
import type { AssembledVideo } from '@application/pipeline/stage/types.js';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { NarrationScript } from '@domain/script/NarrationScript.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import { Duration } from '@domain/shared/Duration.js';
import { JobId } from '@domain/job/JobId.js';
import { JobFeatures } from '@domain/job/JobFeatures.js';
import { VideoStyle } from '@domain/media/VideoStyle.js';

const language = Language.of('en');

const scene = (index: number) => Scene.of({
  index,
  spokenText: `scene ${index} narration`,
  writtenText: `scene ${index} narration`,
  sourcedText: `scene ${index} narration`,
  citations: [Citation.of(`c${index}`, [SourceRef.page('doc', 1)])],
  visualIntent: 'flow',
  estimatedDuration: Duration.fromSeconds(6),
}).withStoryboard(`<section data-scene="${index}">board</section>`, SceneTimeline.unresolved([]));

async function contextFor(): Promise<{ ctx: PipelineContext; workspace: SharedVolumeWorkspace; id: JobId }> {
  const noop = () => {};
  const workspace = new SharedVolumeWorkspace(await mkdtemp(join(tmpdir(), 'run-artifacts-')));
  const id = JobId.generate();
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };

  return {
    workspace,
    id,
    ctx: {
      job: {
        id,
        outputLanguage: language,
        style: VideoStyle.of({ name: 'explainer', label: 'E', narration: 'clear', visual: 'sparse' }),
        features: JobFeatures.of({
          images: true, imageSources: ['wikimedia'], planReview: true, research: 'none',
        }),
      } as unknown as PipelineContext['job'],
      workspace,
      logger: log as unknown as PipelineContext['logger'],
    } as unknown as PipelineContext,
  };
}

const video = (): AssembledVideo => ({
  script: NarrationScript.of([scene(0), scene(1)], language, {
    register: 'plain', assumedPriorKnowledge: 'none', structure: 'linear',
    emphasisedTopics: [], styleNote: 'clear',
    explicitInstructions: undefined, extraDirection: undefined,
  }),
} as unknown as AssembledVideo);

describe('RunArtifacts', () => {
  it('writes nothing at all when it is off', async () => {
    const { ctx, workspace, id } = await contextFor();
    await new RunArtifacts(false).write(video(), ctx);

    expect(await workspace.list(id, '13-run/')).toEqual([]);
  });

  it('lays a run out by scene, with an index', async () => {
    const { ctx, workspace, id } = await contextFor();
    await new RunArtifacts(true).write(video(), ctx);

    // `list` is per-directory, which is the workspace's existing contract.
    expect(await workspace.list(id, '13-run/')).toEqual(['13-run/run.json']);
    expect(await workspace.list(id, '13-run/scene-000/')).toEqual([
      '13-run/scene-000/board.html', '13-run/scene-000/scene.json',
    ]);
    expect(await workspace.list(id, '13-run/scene-001/')).toHaveLength(2);
  });

  it('records what the job actually ran with', async () => {
    const { ctx, workspace, id } = await contextFor();
    await new RunArtifacts(true).write(video(), ctx);

    const index = JSON.parse((await workspace.get(id, '13-run/run.json')).toString('utf8'));
    expect(index).toMatchObject({ scenes: 2, language: 'en', style: 'explainer' });
    expect(index.features).toEqual({
      images: true, imageSources: ['wikimedia'], planReview: true, research: 'none',
    });
    expect(index.scene_folders).toEqual(['13-run/scene-000', '13-run/scene-001']);
  });

  it('keeps the board as it was rendered, so a scene can be re-opened', async () => {
    const { ctx, workspace, id } = await contextFor();
    await new RunArtifacts(true).write(video(), ctx);

    const html = (await workspace.get(id, '13-run/scene-001/board.html')).toString('utf8');
    expect(html).toContain('data-scene="1"');
  });

  /**
   * The artifacts live *in* the workspace, so keeping one without the other
   * leaves a folder of dangling references.
   */
  it('says that keeping a run means keeping its workspace', () => {
    expect(new RunArtifacts(true).keepsWorkspace).toBe(true);
    expect(new RunArtifacts(false).keepsWorkspace).toBe(false);
  });
});
