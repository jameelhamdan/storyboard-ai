import sharp from 'sharp';
import { TracedArtwork } from '@domain/media/TracedArtwork.js';

/**
 * The grid the trace runs on.
 *
 * Small on purpose. The board is 1280x720 and the plate is a fraction of it, so
 * detail below this is invisible in the finished video — and every extra pixel
 * of width is quadratically more contour to walk, simplify and inline into the
 * markup. 360 keeps a whiteboard drawing's strokes intact and the path data
 * around a few kilobytes.
 */
const TRACE_WIDTH = 360;

/**
 * Contours shorter than this are noise: compression artefacts, stray marks, the
 * odd speck. Drawing them adds visible litter and, worse, spends the reveal
 * stagger on strokes nobody can see.
 */
const MIN_CONTOUR_POINTS = 24;

/** Enough to draw a diagram; far short of enough to draw a photograph. */
const MAX_CONTOURS = 48;

/**
 * Above this many contours, the image is not line art.
 *
 * A published diagram traces into tens of boundaries. A photograph traces into
 * hundreds of fragments of shadow and texture, and drawing them produces visual
 * noise that is strictly worse than showing the photograph. Truncating to
 * `MAX_CONTOURS` would *hide* that by keeping the 48 longest fragments, so the
 * count is checked before anything is discarded.
 */
const NOT_LINE_ART_ABOVE = 150;

/** Douglas–Peucker tolerance, in grid units. Below a pixel is not worth keeping. */
const SIMPLIFY_TOLERANCE = 0.8;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A picture → the strokes that draw it.
 *
 * Returns `undefined` rather than throwing when there is nothing worth drawing:
 * a photograph traces into a few hundred meaningless fragments, and a blank
 * image into none at all. Both are ordinary answers, and the caller's response
 * to each is the same — show the picture as it is.
 *
 * Nothing here invents anything. The contours are the ones already in the
 * image, so a traced board draws the published figure it credits.
 *
 * **Deterministic by construction.** Fixed working width, a threshold computed
 * from the image's own histogram by Otsu's method, a boundary walk with a fixed
 * starting rule and a fixed neighbour order, and a fixed simplification
 * tolerance. The same bytes give the same paths on any machine, which is what
 * lets the result be cached in a checkpoint and re-rendered elsewhere.
 */
export async function traceContours(
  image: { bytes: Buffer },
): Promise<TracedArtwork | undefined> {
  const { data, info } = await sharp(image.bytes)
    .greyscale()
    .resize({ width: TRACE_WIDTH, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const threshold = otsu(data);

  // Ink is dark on a light board. A pixel at exactly the threshold counts as
  // background, so a flat image yields no contours rather than one enormous one.
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i += 1) ink[i] = data[i]! < threshold ? 1 : 0;

  const contours = walkBoundaries(ink, width, height);
  if (contours.length === 0) return undefined;

  if (contours.length > NOT_LINE_ART_ABOVE) {
    // A photograph, or a diagram over a photographic background. Either way,
    // drawing it would be worse than showing it.
    return undefined;
  }

  const paths = contours
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_CONTOURS)
    .map((contour) => simplify(contour, SIMPLIFY_TOLERANCE))
    .filter((contour) => contour.length >= 3)
    .map(toPathData);

  if (paths.length === 0) return undefined;

  return TracedArtwork.of({ width, height, paths });
}

/**
 * Otsu's method: the threshold that best separates the histogram into two
 * groups.
 *
 * A fixed 128 would do for art we generated ourselves, and fail on anything
 * scanned, photographed or drawn on a tinted board. Computing it from the image
 * costs one pass and removes a whole class of "it worked on my example".
 */
function otsu(data: Buffer): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of data) histogram[value] = (histogram[value] ?? 0) + 1;

  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;

    const variance = weightBackground * weightForeground
      * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Moore-neighbour boundary following: walk the outline of every ink region.
 *
 * Chosen over marching squares because line art is *strokes*, and the outline of
 * a stroke drawn along its own length reads exactly like the stroke being drawn
 * — which is the effect wanted — while marching squares' hole handling is
 * fiddly and buys nothing here.
 *
 * The neighbour order is fixed and the scan starts at the first unvisited ink
 * pixel whose left neighbour is background, so the walk is reproducible.
 */
function walkBoundaries(ink: Uint8Array, width: number, height: number): Point[][] {
  const visited = new Uint8Array(ink.length);
  const contours: Point[][] = [];

  // Clockwise from west, which is the direction the scan arrives from.
  const neighbours = [
    [-1, 0], [-1, -1], [0, -1], [1, -1],
    [1, 0], [1, 1], [0, 1], [-1, 1],
  ] as const;

  const at = (x: number, y: number): number =>
    (x < 0 || y < 0 || x >= width || y >= height ? 0 : ink[y * width + x]!);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (ink[index] !== 1 || visited[index] === 1 || at(x - 1, y) !== 0) continue;

      const contour: Point[] = [];
      let current = { x, y };
      let entry = 0;

      // Bounded by the pixel count: a walk that cannot close is a bug, and
      // spinning forever inside a render worker is the worst way to find out.
      for (let step = 0; step < ink.length * 2; step += 1) {
        visited[current.y * width + current.x] = 1;
        contour.push(current);

        let found = false;
        for (let n = 0; n < neighbours.length; n += 1) {
          const direction = (entry + n) % neighbours.length;
          const [dx, dy] = neighbours[direction]!;
          const next = { x: current.x + dx, y: current.y + dy };

          if (at(next.x, next.y) === 1) {
            // Re-enter from the far side, so the walk continues around the
            // region rather than doubling back into it.
            entry = (direction + 6) % neighbours.length;
            current = next;
            found = true;
            break;
          }
        }

        if (!found) break;
        if (current.x === x && current.y === y && contour.length > 2) break;
      }

      if (contour.length >= MIN_CONTOUR_POINTS) contours.push(contour);
    }
  }
  return contours;
}

/**
 * Douglas–Peucker. A traced boundary has a point per pixel step, and inlining
 * that into the markup would put tens of kilobytes of path data on a board where
 * a tenth of it is visually identical.
 */
function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];

  const first = points[0]!;
  const last = points[points.length - 1]!;

  let index = 0;
  let furthest = 0;

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i]!, first, last);
    if (distance > furthest) {
      furthest = distance;
      index = i;
    }
  }

  if (furthest <= tolerance) return [first, last];

  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - start.x, point.y - start.y);

  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

/** Closed, because a boundary walk ends where it started. */
function toPathData(points: readonly Point[]): string {
  const [first, ...rest] = points;
  if (!first) return '';

  return [
    `M${round(first.x)} ${round(first.y)}`,
    ...rest.map((point) => `L${round(point.x)} ${round(point.y)}`),
    'Z',
  ].join('');
}

/** One decimal is finer than a 360-wide grid can express, and halves the bytes. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
