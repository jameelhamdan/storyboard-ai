import { describe, it, expect } from 'vitest';
import { StubStoryboardGenerator } from '@infrastructure/stub/StubStoryboardGenerator.js';
import { DeterministicSceneChecks } from '@infrastructure/judge/DeterministicSceneChecks.js';
import { DIAGRAM_SHAPES, type DiagramShape } from '@domain/script/DiagramShape.js';
import { Scene } from '@domain/script/Scene.js';
import { SceneTimeline } from '@domain/script/SceneTimeline.js';
import { Duration } from '@domain/shared/Duration.js';
import { Citation } from '@domain/content/Citation.js';
import { SourceRef } from '@domain/content/SourceRef.js';

const generator = new StubStoryboardGenerator();
const checks = new DeterministicSceneChecks();

const sceneOf = (visualIntent: DiagramShape) => Scene.of({
  index: 0,
  spokenText: 'glycolysis splits glucose into two molecules of pyruvate releasing energy',
  citations: [Citation.of('c0', [SourceRef.page('doc', 1)])],
  visualIntent,
  estimatedDuration: Duration.fromMs(6000),
});

const failuresFor = async (html: string, anchors: Parameters<typeof SceneTimeline.unresolved>[0]) =>
  (await checks.check({
    scenes: [sceneOf('focus').withStoryboard(html, SceneTimeline.unresolved(anchors))],
  }))[0]!.failures;

/**
 * The fallback exists to rescue a scene the model could not get past the gates.
 * It used to emit a bullet list — which A8 now rejects — so it would have failed
 * the very gate it was rescuing the scene from, and every stub run would have
 * produced a narrated slideshow.
 */
describe('the storyboard fallback always draws something', () => {
  it.each(DIAGRAM_SHAPES)('produces a diagram for %s', async (shape) => {
    const { html, anchors } = await generator.regenerate({ scene: sceneOf(shape) });
    const failures = await failuresFor(html, anchors);

    expect(failures.filter((f) => f.startsWith('A8')), `${shape} produced a text-only board`).toEqual([]);
  });

  it('passes every Stage A check, not just the diagram one', async () => {
    for (const shape of DIAGRAM_SHAPES) {
      const { html, anchors } = await generator.regenerate({ scene: sceneOf(shape) });
      expect(await failuresFor(html, anchors), shape).toEqual([]);
    }
  });

  it('draws a real diagram even on the last-resort path', async () => {
    const { html, anchors } = generator.fallback(sceneOf('flow'));

    expect(await failuresFor(html, anchors)).toEqual([]);
    // The last resort is `focus`, which carries a drawn underline.
    expect(html).toMatch(/<svg/);
    expect(html).not.toMatch(/sc-bullet-list/);
  });

  it('never emits a bullet list for any shape', async () => {
    for (const shape of DIAGRAM_SHAPES) {
      const { html } = await generator.regenerate({ scene: sceneOf(shape) });
      expect(html, shape).not.toMatch(/<ul|<ol/);
    }
  });

  it('varies the shape it draws, rather than one layout for everything', async () => {
    const bodies = new Set<string>();
    for (const shape of DIAGRAM_SHAPES) {
      const { html } = await generator.regenerate({ scene: sceneOf(shape) });
      bodies.add(html.replace(/<h2[\s\S]*?<\/h2>/, ''));
    }
    expect(bodies.size).toBeGreaterThan(3);
  });
});
