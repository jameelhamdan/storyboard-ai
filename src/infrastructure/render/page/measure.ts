/**
 * What a laid-out board can be asked about directly.
 *
 * This is the replacement for judge gate G4's "is anything overlapping or
 * clipped" clause, and it exists because that clause did not work: in
 * `out/20260827-202226-battery` scene 0 shipped with its centre box covering the
 * label beside it and passed all five gates with a holistic score of 4. A vision
 * model reading a screenshot is being asked to notice something a browser
 * already knows exactly.
 *
 * Three properties, all of them free once the page is loaded:
 *
 * - **Overlap** — two inked elements sitting on top of each other.
 * - **Clipping** — anything outside the frame, which the board's `overflow:
 *   hidden` would silently cut off.
 * - **Legibility** — text below the theme's minimum size.
 *
 * Runs as a string inside `page.evaluate` rather than as an imported function,
 * for the same reason `seek.ts` does: it executes in the browser, where none of
 * this module's imports exist.
 */

/**
 * Elements that carry ink and may not sit on top of one another.
 *
 * Containers are deliberately absent. `nested` boxes contain each other by
 * design, so asserting on the labels rather than the frames measures the thing
 * that would actually be unreadable.
 */
const INKED = [
  '.sc-title', '.sc-caption', '.sc-node', '.sc-side', '.sc-layer', '.sc-cell',
  '.sc-part', '.sc-term', '.sc-event', '.sc-bar-row', '.sc-nest-label',
  '.sc-focus-text', '.sc-whole', '.sc-axis-x', '.sc-axis-y',
].join(',');

/** Sub-pixel rounding and shared borders are not collisions. */
const TOLERANCE_PX = 1;

export function measureScript(width: number, height: number, minFontPx: number): string {
  return `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(INKED)})];
  const boxes = els.map((e) => {
    const b = e.getBoundingClientRect();
    return { text: (e.textContent || '').trim().slice(0, 30), l: b.left, t: b.top, r: b.right, b: b.bottom };
  }).filter((x) => x.r > x.l && x.b > x.t);

  const failures = [];

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], c = boxes[j];
      const ox = Math.min(a.r, c.r) - Math.max(a.l, c.l);
      const oy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
      if (ox > ${TOLERANCE_PX} && oy > ${TOLERANCE_PX}) {
        failures.push('A6: "' + a.text + '" overlaps "' + c.text + '" by ' +
                      Math.round(ox) + 'x' + Math.round(oy) + 'px');
      }
    }
  }

  for (const box of boxes) {
    if (box.l < -${TOLERANCE_PX} || box.t < -${TOLERANCE_PX} ||
        box.r > ${width} + ${TOLERANCE_PX} || box.b > ${height} + ${TOLERANCE_PX}) {
      failures.push('A4: "' + box.text + '" is outside the frame and will be cut off');
    }
  }

  for (const e of els) {
    const size = parseFloat(getComputedStyle(e).fontSize);
    if (size > 0 && size < ${minFontPx} - 0.5) {
      failures.push('A5: "' + (e.textContent || '').trim().slice(0, 30) + '" renders at ' +
                    Math.round(size) + 'px, below the ' + ${minFontPx} + 'px floor');
    }
  }

  // A board scaled down to fit is a board the template built too big. Reported
  // rather than accepted, because the scaling is a symptom.
  const fitted = document.documentElement.dataset.fitted;
  if (fitted) failures.push('A4: the board had to be scaled to ' + fitted + ' to fit its frame');

  // Deduplicated: one bad element collides with several neighbours and would
  // otherwise fill the retry prompt with the same complaint.
  return [...new Set(failures)].slice(0, 8);
})()`;
}
