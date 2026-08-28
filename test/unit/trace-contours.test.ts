import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { traceContours } from '@infrastructure/render/diagram/traceContours.js';
import { TracedArtwork } from '@domain/media/TracedArtwork.js';
import { SceneDiagram } from '@domain/script/SceneDiagram.js';
import { SceneImage } from '@domain/media/SceneImage.js';
import { renderDiagram } from '@infrastructure/render/diagram/renderDiagram.js';
import { HtmlSanitizer } from '@infrastructure/render/HtmlSanitizer.js';

const lineArt = (): Promise<Buffer> => sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">'
  + '<rect width="800" height="600" fill="#ffffff"/>'
  + '<circle cx="400" cy="300" r="180" fill="none" stroke="#000000" stroke-width="8"/>'
  + '<rect x="220" y="120" width="360" height="360" fill="none" stroke="#000000" stroke-width="8"/>'
  + '</svg>',
)).png().toBuffer();

const blank = (): Promise<Buffer> =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();

/**
 * The board's aesthetic is that everything is drawn. A picture is the one
 * element that would merely appear — tracing closes that gap, and does it once
 * at storyboard time so every frame stays a pure function of the frame number.
 */
describe('traceContours', () => {
  it('turns line art into strokes', async () => {
    const traced = await traceContours({ bytes: await lineArt() });

    expect(traced).toBeDefined();
    expect(traced!.paths.length).toBeGreaterThan(0);
    // Two shapes, each contributing an inner and an outer boundary.
    expect(traced!.paths.length).toBeLessThan(12);
    expect(traced!.viewBox).toMatch(/^0 0 \d+ \d+$/);
  });

  /**
   * The resume guarantee depends on this: a segment re-rendered on another
   * worker has to produce the same pixels, and it cannot if the strokes differ.
   */
  it('gives identical paths for identical bytes', async () => {
    const bytes = await lineArt();
    const [first, second] = await Promise.all([
      traceContours({ bytes }), traceContours({ bytes }),
    ]);

    expect(second!.paths).toEqual(first!.paths);
  });

  it('finds nothing in a blank image, rather than one enormous stroke', async () => {
    expect(await traceContours({ bytes: await blank() })).toBeUndefined();
  });

  /** Inlined into the markup, so path data is a size that has to stay bounded. */
  it('simplifies enough to inline', async () => {
    const traced = await traceContours({ bytes: await lineArt() });
    expect(traced!.paths.join('').length).toBeLessThan(20_000);
  });

  it('closes every path it emits', async () => {
    const traced = await traceContours({ bytes: await lineArt() });
    for (const path of traced!.paths) {
      expect(path.startsWith('M')).toBe(true);
      expect(path.endsWith('Z')).toBe(true);
    }
  });

  it('refuses to exist with no strokes at all', () => {
    expect(() => TracedArtwork.of({ width: 10, height: 10, paths: [] })).toThrow(/at least one stroke/);
  });
});

describe('a traced illustration renders as strokes rather than as a picture', () => {
  const boardWith = async (traced: boolean) => {
    const bytes = await lineArt();
    const base = SceneImage.of({
      dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      alt: 'a drawing',
      attribution: {
        author: 'Generated', sourceName: 'a model', sourceUrl: '', licence: 'AI-generated',
      },
      width: 800,
      height: 600,
      source: 'generated',
    });

    const artwork = traced ? await traceContours({ bytes }) : undefined;

    return renderDiagram(
      SceneDiagram.of({
        shape: 'illustration',
        title: 'A drawn board',
        nodes: [{ id: 'a', label: 'A part', anchor: 'the first phrase' }],
        imageBrief: { query: 'a drawing', kind: 'diagram', alt: 'a drawing' },
      }).withImage(artwork ? base.withTracing(artwork) : base),
      0,
    ).html;
  };

  it('emits drawable paths and no image', async () => {
    const html = await boardWith(true);

    expect(html).toContain('<svg class="sc-trace"');
    expect(html).not.toContain('<img');
  });

  /**
   * The reveal rule sets `stroke-dasharray: 1`, so a path without
   * `pathLength="1"` gets a one-user-unit dash pattern and renders as a dotted
   * crumb rather than drawing itself.
   */
  it('normalises the length of every stroke', async () => {
    const html = await boardWith(true);
    for (const path of html.match(/<path\b[^>]*>/g) ?? []) {
      expect(path).toContain('pathLength="1"');
    }
  });

  it('still shows a picture that could not be traced', async () => {
    expect(await boardWith(false)).toContain('<img');
  });

  it('keeps the credit line either way', async () => {
    expect(await boardWith(true)).toContain('AI-generated');
    expect(await boardWith(false)).toContain('AI-generated');
  });

  /** The sanitizer strips silently, so markup it would rewrite must never be emitted. */
  it('survives sanitising byte for byte', async () => {
    const html = await boardWith(true);
    const sanitizer = new HtmlSanitizer();

    expect(sanitizer.sanitize(html).violations).toEqual([]);
    expect(sanitizer.sanitize(html).html).toBe(html);
  });
});
