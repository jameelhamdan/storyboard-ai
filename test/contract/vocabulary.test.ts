import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIAGRAM_SHAPES, SHAPE_GUIDANCE, SHAPE_LIMITS } from '@domain/script/DiagramShape.js';
import { diagramFor } from '../helpers/diagrams.js';
import { renderDiagram } from '@infrastructure/render/diagram/renderDiagram.js';
import { HtmlSanitizer } from '@infrastructure/render/HtmlSanitizer.js';

/**
 * The sanitizer used to be the enforcement mechanism for a contract the model
 * was asked to follow. It now guards markup this service generates itself,
 * which changes what is worth asserting: not "can the model's output survive
 * this", but "does our own renderer ever emit something this would quietly
 * delete".
 *
 * That distinction is not academic. The sanitizer strips `style=` attributes
 * *without recording a gate failure*, so a renderer that emitted one would ship
 * boards missing whatever that style expressed — which is exactly how the old
 * fallback's proportion bars rendered at zero width for months.
 */
describe('the renderer emits markup the sanitizer leaves alone', () => {
  const sanitizer = new HtmlSanitizer();

  const boardFor = async (shape: string) => {
    const limits = SHAPE_LIMITS[shape as keyof typeof SHAPE_LIMITS];
    return renderDiagram(
      await diagramFor({
        shape,
        title: 'A representative title',
        nodes: Array.from({ length: limits.max }, (_, i) => ({
          id: `n${i}`, label: `Node ${i}`, detail: 'a detail', value: 0.5,
          anchor: `phrase ${i}`,
        })),
        edges: Array.from({ length: limits.max - 1 }, (_, i) => ({
          from: `n${i}`, to: `n${i + 1}`, label: 'then',
        })),
        caption: 'A caption under the board.',
        axes: { x: 'across', y: 'down' },
      }),
      0,
    ).html;
  };

  it.each(DIAGRAM_SHAPES)('%s renders with no sanitizer violations', async (shape) => {
    expect(sanitizer.sanitize(await boardFor(shape)).violations).toEqual([]);
  });

  it.each(DIAGRAM_SHAPES)('%s survives sanitising byte for byte', async (shape) => {
    // Violations are only half of it: the sanitizer also rewrites silently.
    const html = await boardFor(shape);
    expect(sanitizer.sanitize(html).html).toBe(html);
  });

  it('still rejects code execution, network reach and non-determinism', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<div class="sc-item" onclick="x()">a</div>',
      '<div class="sc-item" style="color:var(--ink-primary)">a</div>',
      '<style>.sc-a{color:#C53030}</style>',
      '<div class="custom-thing">a</div>',
      '<iframe src="//evil"></iframe>',
      '<img src="http://evil/x.png">',
      '<use xlink:href="http://evil#x"/>',
      '<animate attributeName="x" dur="1s"/>',
      '<foreignObject><div>x</div></foreignObject>',
      // SVG shapes are allowed; SVG *text* is not — it clips instead of
      // reflowing, which is why the ban exists.
      '<svg><text>label</text></svg>',
      '<style>@import url("http://evil/x.css");</style>',
      '<style>.sc-a{animation:spin 1s linear infinite}</style>',
      '<style>.sc-a{transition:all .2s}</style>',
    ];
    for (const html of hostile) {
      expect(sanitizer.sanitize(html).violations.length, html).toBeGreaterThan(0);
    }
  });
});

/**
 * The script stage picks the shape and the renderer draws it. If the two
 * disagree, the picker chooses values nothing downstream can render — which is
 * how this drifted into three separate vocabularies once already.
 */
describe('the shape vocabulary agrees with the prompt that picks from it', () => {
  const script = readFileSync('prompts/01-script-generation.md', 'utf8');

  it('offers exactly the shapes the domain defines', () => {
    const table = script.slice(
      script.indexOf('**`visualIntent`**'),
      script.indexOf('Choose it from the material'),
    );
    const listed = [...table.matchAll(/^\s*\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
    expect(listed.sort()).toEqual([...DIAGRAM_SHAPES].sort());
  });

  /**
   * The illustrator is told its shape's meaning per scene rather than given a
   * table, so the guidance reaching it is `SHAPE_GUIDANCE` by construction.
   * What can still drift is a shape gaining an enum entry with no guidance.
   */
  it('describes every shape it defines', () => {
    for (const shape of DIAGRAM_SHAPES) {
      expect(SHAPE_GUIDANCE[shape]?.length ?? 0, shape).toBeGreaterThan(30);
      expect(SHAPE_LIMITS[shape], shape).toBeDefined();
    }
  });

  /**
   * `list` and `none` are absent on purpose: a board of text is the failure this
   * project exists to avoid, so the vocabulary contains no way to ask for one.
   */
  it('has no way to ask for a board that is not a drawing', () => {
    expect(DIAGRAM_SHAPES).not.toContain('list');
    expect(DIAGRAM_SHAPES).not.toContain('none');
  });
});
