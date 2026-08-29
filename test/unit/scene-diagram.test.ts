import { describe, it, expect } from 'vitest';
import { SceneDiagram } from '@domain/script/SceneDiagram.js';
import { DIAGRAM_SHAPES, SHAPE_LIMITS } from '@domain/script/DiagramShape.js';
import { renderDiagram } from '@infrastructure/render/diagram/renderDiagram.js';
import { diagramFor } from '../helpers/diagrams.js';

const nodes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));

const diagram = (over: Partial<Parameters<typeof SceneDiagram.of>[0]> = {}) =>
  SceneDiagram.of({ shape: 'flow', title: 'A title', nodes: nodes(3), ...over });

describe('SceneDiagram', () => {
  it('accepts a well-formed description', () => {
    const d = diagram();
    expect(d.shape).toBe('flow');
    expect(d.nodes).toHaveLength(3);
  });

  /**
   * The limits are the templates' real constraints. A comparison with three
   * columns is not a tighter fit, it is a different shape — and silently
   * dropping the third would ship a board missing content with nothing recorded
   * to explain it.
   */
  it('enforces each shape\'s node range', () => {
    expect(() => diagram({ shape: 'comparison', nodes: nodes(3) })).toThrow(/takes 2–2 nodes/);
    expect(() => diagram({ shape: 'focus', nodes: nodes(2) })).toThrow(/takes 1–1 nodes/);
    expect(() => diagram({ shape: 'flow', nodes: nodes(1) })).toThrow(/takes 2–4 nodes/);
  });

  it('keeps labels short enough to be labels', () => {
    expect(() => diagram({ nodes: [{ id: 'a', label: 'one two three four five' }, { id: 'b', label: 'B' }] }))
      .toThrow(/allows 4/);
  });

  /**
   * `focus` is the exception: its single node is the board, so it states an
   * idea rather than naming a thing. Without this the last-resort board could
   * not exist.
   */
  it('lets a focus board hold a clause', () => {
    const d = diagram({ shape: 'focus', nodes: [{ id: 'a', label: 'The number of ways a system can be arranged' }] });
    expect(d.nodes[0]!.label).toContain('arranged');
  });

  it('rejects an edge naming a node that does not exist', () => {
    expect(() => diagram({ edges: [{ from: 'n0', to: 'nowhere' }] })).toThrow(/unknown node 'nowhere'/);
    expect(() => diagram({ edges: [{ from: 'n0', to: 'n0' }] })).toThrow(/points at itself/);
  });

  it('rejects duplicate ids, which would make an edge ambiguous', () => {
    expect(() => diagram({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }))
      .toThrow(/Duplicate node id/);
  });

  it('allows only one focal point', () => {
    expect(() => diagram({
      nodes: [{ id: 'a', label: 'A', emphasis: true }, { id: 'b', label: 'B', emphasis: true }],
    })).toThrow(/At most one node may be emphasised/);
  });

  it('rejects a title that is missing or too long to be a title', () => {
    expect(() => diagram({ title: '  ' })).toThrow(/title is empty/);
    expect(() => diagram({ title: 'x'.repeat(61) })).toThrow(/the limit is 60/);
  });

  it('bounds a proportion value to a real share', () => {
    expect(() => diagram({ shape: 'proportion', nodes: [{ id: 'a', label: 'A', value: 1.4 }, { id: 'b', label: 'B' }] }))
      .toThrow(/between 0 and 1/);
  });

  /** Unknown input degrades to the shape that is never wrong, never to a crash. */
  it('coerces an unrecognised shape to focus', () => {
    expect(SceneDiagram.of({ shape: 'spiral', title: 'T', nodes: nodes(1) }).shape).toBe('focus');
  });
});

describe('renderDiagram', () => {
  /**
   * The sanitizer deletes `style=` attributes *without failing a gate*, which is
   * how the previous fallback shipped proportion bars of zero width. Nothing the
   * renderer emits may depend on one.
   */
  it('never emits an inline style attribute', async () => {
    for (const shape of DIAGRAM_SHAPES) {
      const limits = SHAPE_LIMITS[shape];
      const d = await diagramFor({
        shape, title: 'T',
        nodes: nodes(limits.min).map((n) => ({ ...n, value: 0.5 })),
      });
      expect(renderDiagram(d, 0).html, shape).not.toMatch(/\sstyle\s*=/);
    }
  });

  /**
   * The reveal rule sets `stroke-dasharray: 1`, which on a path without
   * `pathLength="1"` is a one-user-unit dash pattern — the line renders as a
   * dotted crumb or vanishes. Half of the broken arrows in the battery run.
   */
  it('gives every drawn path a normalised length', async () => {
    for (const shape of DIAGRAM_SHAPES) {
      const limits = SHAPE_LIMITS[shape];
      const d = await diagramFor({ shape, title: 'T', nodes: nodes(limits.min) });
      const html = renderDiagram(d, 0).html;
      const paths = [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
      for (const path of paths) expect(path, `${shape}: ${path}`).toContain('pathLength="1"');
    }
  });

  it('anchors every node and edge that carries a phrase', () => {
    const d = SceneDiagram.of({
      shape: 'flow', title: 'T',
      nodes: [{ id: 'a', label: 'A', anchor: 'the first' }, { id: 'b', label: 'B' }],
      edges: [{ from: 'a', to: 'b', anchor: 'becomes' }],
    });
    const { anchors } = renderDiagram(d, 2);

    // The title always leads, with no phrase, so it lands at scene start, and
    // it belongs to step 1 — a board's heading is there from the first frame.
    expect(anchors[0]).toEqual({
      elementId: 's2-title', phrase: undefined, draw: 'normal', hold: true, step: 1,
    });
    // Document order — the arrow sits between the two boxes it joins. Order here
    // does not decide what draws first; SceneTimeline resolves by time, so an
    // impossible sequence cannot be authored.
    expect(anchors.map((a) => a.phrase)).toEqual([undefined, 'the first', 'becomes', undefined]);
    // Ids must match the markup, or the reveal time is never delivered.
    for (const anchor of anchors) {
      expect(renderDiagram(d, 2).html).toContain(`id="${anchor.elementId}"`);
    }
  });

  /**
   * The join between a built board and the per-scene timelines.
   *
   * Each scene resolves only its own step's anchors, against its own measured
   * timings, so the step has to survive the round trip out to markup and back.
   * If it did not, every scene would try to resolve every phrase, fail on most
   * of them, and inherit timings — a board that draws itself all at once.
   */
  it('carries each element\'s step out to the markup and back', () => {
    const d = SceneDiagram.of({
      shape: 'flow', title: 'T', steps: 2,
      nodes: [
        { id: 'a', label: 'A', anchor: 'the first', step: 1 },
        { id: 'b', label: 'B', anchor: 'the second', step: 2 },
      ],
      edges: [{ from: 'a', to: 'b', anchor: 'becomes', step: 2 }],
    });
    const { html, anchors } = renderDiagram(d, 0);

    expect(html).toContain('data-step="2"');
    // Stamped on step 1 as well: the seek script finds what to dim with
    // `[data-step]`, and step 1 is the first set that has to recede.
    expect(html).toContain('data-step="1"');

    const byStep = (step: number) =>
      anchors.filter((a) => (a.step ?? 1) === step).map((a) => a.phrase);

    // Document order within each step, as above: the arrow sits between the two
    // boxes it joins, so it precedes the node it points at.
    expect(byStep(1)).toEqual([undefined, 'the first']);
    expect(byStep(2)).toEqual(['becomes', 'the second']);
  });

  it('escapes text that would otherwise close a tag', () => {
    const d = SceneDiagram.of({
      shape: 'focus', title: 'A <script> tag', nodes: [{ id: 'a', label: '"quoted" & <b>' }],
    });
    const html = renderDiagram(d, 0).html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
  });

  it('draws a return arc for a cycle even when no closing edge was given', () => {
    const d = SceneDiagram.of({ shape: 'cycle', title: 'T', nodes: nodes(3) });
    expect(renderDiagram(d, 0).html).toContain('sc-return-arc');
  });

  /**
   * Reveal times are keyed by element id and stamped onto whichever element
   * carries it, so two elements sharing one id means one of them silently never
   * receives its time. A `cycle` used to hit this: its return arc reused the id
   * of the last arrow between two nodes.
   */
  it('never gives two elements the same id', async () => {
    for (const shape of DIAGRAM_SHAPES) {
      const limits = SHAPE_LIMITS[shape];
      const nodeList = nodes(limits.max);
      const d = await diagramFor({
        shape, title: 'T',
        nodes: nodeList,
        edges: nodeList.slice(1).map((n, i) => ({ from: nodeList[i]!.id, to: n.id })),
        caption: 'A caption.',
        axes: { x: 'x', y: 'y' },
      });
      const ids = [...renderDiagram(d, 0).html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
      expect(new Set(ids).size, `${shape}: ${ids.join(', ')}`).toBe(ids.length);
    }
  });
});
