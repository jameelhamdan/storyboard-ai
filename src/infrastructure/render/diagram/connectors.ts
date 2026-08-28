/**
 * The drawn lines between things.
 *
 * Two rules govern everything here, and both come from bugs found by looking at
 * rendered frames rather than at markup:
 *
 * 1. **An arrowhead is stroked, never filled.** Drawing the head as two more
 *    line segments in the same `d` means it draws itself along with the shaft,
 *    for free, rather than popping in at the end. It also sidesteps the rule
 *    that made every arrowhead in `out/20260827-202226-battery` invisible:
 *    `stylesheet.ts` forced `fill: none` on every `sc-`-prefixed SVG child at a
 *    specificity nothing could beat, and the storyboard contract required every
 *    class to carry that prefix — so a `<polygon>` head or a `<marker>` could
 *    not be filled by anything. That rule is now scoped to paths, but a stroked
 *    head is still the better answer.
 *
 * 2. **Every path carries `pathLength="1"`.** The reveal rule sets
 *    `stroke-dasharray: 1`, which on a path without it means a one-user-unit
 *    dash pattern — the line renders as a dotted crumb or vanishes. That is the
 *    other half of the broken arrows in `out/20260827-202226-battery`.
 *
 * Connectors sit in normal flow between the things they join, so they cannot be
 * positioned wrongly relative to them. The ones that must span a whole row
 * stretch with `preserveAspectRatio="none"`; their heads distort by a few
 * percent at 1280x720, which is not visible, and the alternative is absolute
 * positioning.
 */

/** A right-pointing arrow, sized to sit between two nodes in a row. */
export function arrowRight(attrs: string): string {
  return svg('sc-conn', '0 0 90 50', attrs, 'M 6 25 H 74 M 62 15 L 76 25 L 62 35');
}

/**
 * The closing arc of a cycle: out of the last node, back under the row, into
 * the first. Spans the full width of the row it sits beneath.
 *
 * A cycle drawn as a ring needs absolute positioning and collides as soon as one
 * label runs long. Drawn as a row with a return underneath it, the same idea
 * costs no positioning at all — and it is what "one loop, not two lists" asks
 * for.
 */
export function returnArc(attrs: string): string {
  return svg(
    'sc-return-arc',
    '0 0 1000 90',
    `${attrs} preserveAspectRatio="none"`,
    'M 985 4 C 985 62, 950 84, 890 84 H 110 C 50 84, 15 62, 15 4 M 6 26 L 15 4 L 24 26',
  );
}

/**
 * A root's connection to the row of children beneath it: down, across, then
 * down into each child with a head.
 *
 * `count` decides the drop positions, so the bracket always lands on the
 * children's centres — the columns are equal-width by construction, which is
 * what makes that computable without measuring anything.
 */
export function bracket(count: number, attrs: string): string {
  const centre = (i: number) => ((i + 0.5) / count) * 1000;
  const first = centre(0);
  const last = centre(count - 1);

  const drops = Array.from({ length: count }, (_, i) => {
    const x = centre(i).toFixed(1);
    return `M ${x} 30 V 72 M ${(centre(i) - 9).toFixed(1)} 62 L ${x} 76 L ${(centre(i) + 9).toFixed(1)} 62`;
  });

  return svg(
    'sc-bracket',
    '0 0 1000 90',
    `${attrs} preserveAspectRatio="none"`,
    [`M 500 0 V 30`, `M ${first.toFixed(1)} 30 H ${last.toFixed(1)}`, ...drops].join(' '),
  );
}

/** A short leader line from a label to the thing it names. */
export function leader(attrs: string): string {
  return svg('sc-leader', '0 0 70 20', attrs, 'M 4 10 H 66');
}

/** The drawn axis a timeline's events sit along, with a tick per event. */
export function axis(count: number, attrs: string): string {
  const ticks = Array.from({ length: count }, (_, i) => {
    const x = (((i + 0.5) / count) * 1000).toFixed(1);
    return `M ${x} 6 V 26`;
  });
  return svg(
    'sc-axis',
    '0 0 1000 32',
    `${attrs} preserveAspectRatio="none"`,
    [`M 4 16 H 996`, ...ticks].join(' '),
  );
}

/** The hand-drawn rule under a `focus` board's one idea. */
export function underline(attrs: string): string {
  return svg('sc-underline', '0 0 400 14', `${attrs} preserveAspectRatio="none"`, 'M 4 9 Q 200 1 396 9');
}

function svg(cls: string, viewBox: string, attrs: string, d: string): string {
  return (
    `<svg class="${cls}" viewBox="${viewBox}" aria-hidden="true">` +
    `<path class="sc-stroke" ${attrs} d="${d}" pathLength="1"/>` +
    `</svg>`
  );
}
