import sharp from 'sharp';
import { SceneDiagram, type ImageBrief } from '@domain/script/SceneDiagram.js';
import { SceneImage } from '@domain/media/SceneImage.js';

/**
 * One board per shape, so a render shows the whole vocabulary.
 *
 * Shared by `render-demo.ts`, which encodes them to video, and
 * `shape-shots.ts`, which stills them. Every `anchor` is a verbatim substring
 * of its scene's narration, exactly as the prompt requires of the model — so a
 * demo fails the same way a real scene would if anchor resolution broke.
 */
export interface DemoBoard {
  readonly shape: string;
  readonly narration: string;
  readonly title: string;
  readonly nodes: { id: string; label: string; detail?: string; value?: number; emphasis?: boolean; anchor?: string }[];
  readonly edges?: { from: string; to: string; label?: string }[];
  readonly axes?: { x?: string; y?: string };
  readonly caption?: string;
  /** `illustration` only: what its board goes and finds. */
  readonly imageBrief?: ImageBrief;
}

/**
 * A demo board as a validated diagram, with an image attached when the shape
 * needs one.
 *
 * The image is *drawn here* rather than searched for. A demo has to render with
 * no credentials and no network — that is what makes it a demo — and an
 * `illustration` plate with no picture renders as a credit line under a hole.
 * The placeholder is a plain grey field at a real photograph's aspect ratio, so
 * it exercises the same layout path a found image would.
 */
export async function demoDiagram(spec: DemoBoard, index = 0): Promise<SceneDiagram> {
  const diagram = SceneDiagram.of({
    shape: spec.shape,
    title: spec.title,
    nodes: spec.nodes,
    ...(spec.edges ? { edges: spec.edges } : {}),
    ...(spec.axes ? { axes: spec.axes } : {}),
    ...(spec.caption ? { caption: spec.caption } : {}),
    ...(spec.imageBrief ? { imageBrief: spec.imageBrief } : {}),
  });

  if (!diagram.imageBrief) return diagram;
  void index;

  const bytes = await sharp({
    create: { width: 960, height: 640, channels: 3, background: { r: 205, g: 203, b: 196 } },
  }).webp({ quality: 80 }).toBuffer();

  return diagram.withImage(SceneImage.of({
    dataUri: `data:image/webp;base64,${bytes.toString('base64')}`,
    alt: diagram.imageBrief.alt,
    attribution: {
      author: 'Placeholder',
      sourceName: 'Wikimedia Commons',
      sourceUrl: 'https://commons.wikimedia.org',
      licence: 'CC BY-SA 4.0',
    },
    width: 960,
    height: 640,
    source: 'wikimedia',
  }));
}

export const DEMOS: DemoBoard[] = [
  {
    shape: 'flow', narration: 'Glycolysis splits glucose into pyruvate, which enters the mitochondrion.',
    title: 'Stage one — glycolysis',
    nodes: [
      { id: 'a', label: 'Glucose', anchor: 'splits glucose' },
      { id: 'b', label: 'Pyruvate', anchor: 'into pyruvate' },
      { id: 'c', label: 'Mitochondrion', anchor: 'the mitochondrion' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  },
  {
    shape: 'cycle', narration: 'Charging moves lithium one way and discharging returns it to the start.',
    title: 'Charging and discharging are one loop',
    nodes: [
      { id: 'a', label: 'Cathode', anchor: 'Charging moves' },
      { id: 'b', label: 'Anode', anchor: 'lithium one way' },
      { id: 'c', label: 'Cathode again', anchor: 'discharging returns it' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    caption: 'The cell arrives back where it started.',
  },
  {
    shape: 'comparison', narration: 'Aerobic respiration yields about thirty-six molecules while anaerobic yields only two.',
    title: 'Why oxygen matters',
    nodes: [
      { id: 'a', label: 'Aerobic', detail: 'about thirty-six', anchor: 'thirty-six molecules' },
      { id: 'b', label: 'Anaerobic', detail: 'only two', anchor: 'only two' },
    ],
  },
  {
    shape: 'tree', narration: 'Rocks are igneous, sedimentary or metamorphic.',
    title: 'Three kinds of rock',
    nodes: [
      { id: 'r', label: 'Rocks', anchor: 'Rocks are' },
      { id: 'a', label: 'Igneous', anchor: 'igneous' },
      { id: 'b', label: 'Sedimentary', anchor: 'sedimentary' },
      { id: 'c', label: 'Metamorphic', anchor: 'metamorphic' },
    ],
  },
  {
    shape: 'nested', narration: 'The nucleus sits inside the cell, and the chromosome inside the nucleus.',
    title: 'What contains what',
    nodes: [
      { id: 'a', label: 'Cell', anchor: 'inside the cell' },
      { id: 'b', label: 'Nucleus', anchor: 'The nucleus' },
      { id: 'c', label: 'Chromosome', anchor: 'the chromosome' },
    ],
  },
  {
    shape: 'stack', narration: 'The crust sits on the mantle, and the mantle on the core.',
    title: 'Inside the Earth',
    nodes: [
      { id: 'a', label: 'Crust', anchor: 'The crust' },
      { id: 'b', label: 'Mantle', anchor: 'the mantle' },
      { id: 'c', label: 'Core', anchor: 'the core' },
    ],
  },
  {
    shape: 'proportion', narration: 'Nitrogen is most of the air, oxygen about a fifth, argon barely any.',
    title: 'What the air is made of',
    nodes: [
      { id: 'a', label: 'Nitrogen', value: 0.78, anchor: 'Nitrogen is most' },
      { id: 'b', label: 'Oxygen', value: 0.21, anchor: 'oxygen about a fifth' },
      { id: 'c', label: 'Argon', value: 0.01, anchor: 'argon barely any' },
    ],
  },
  {
    shape: 'timeline', narration: 'Light arrives, the reaction runs, and sugar is stored.',
    title: 'The order things happen',
    nodes: [
      { id: 'a', label: 'Light', detail: 'arrives', anchor: 'Light arrives' },
      { id: 'b', label: 'Reaction', detail: 'runs', anchor: 'the reaction runs' },
      { id: 'c', label: 'Sugar', detail: 'stored', anchor: 'sugar is stored' },
    ],
  },
  {
    shape: 'matrix', narration: 'Cost and speed give four options, and only one is both cheap and fast.',
    title: 'Cost against speed',
    axes: { x: 'cost', y: 'speed' },
    nodes: [
      { id: 'a', label: 'Cheap and fast', emphasis: true, anchor: 'cheap and fast' },
      { id: 'b', label: 'Costly, fast', anchor: 'four options' },
      { id: 'c', label: 'Cheap, slow', anchor: 'Cost and speed' },
      { id: 'd', label: 'Costly, slow', anchor: 'only one' },
    ],
  },
  {
    shape: 'parts', narration: 'A cell has an anode, a cathode, an electrolyte and a separator.',
    title: 'What a cell is made of',
    nodes: [
      { id: 'w', label: 'Cell', anchor: 'A cell has' },
      { id: 'a', label: 'Anode', anchor: 'an anode' },
      { id: 'b', label: 'Cathode', anchor: 'a cathode' },
      { id: 'c', label: 'Electrolyte', anchor: 'an electrolyte' },
      { id: 'd', label: 'Separator', anchor: 'a separator' },
    ],
  },
  {
    shape: 'equation', narration: 'Force equals mass times acceleration.',
    title: 'Force, mass and acceleration',
    nodes: [
      { id: 'm', label: 'Mass', anchor: 'equals mass' },
      { id: 'a', label: 'Acceleration', anchor: 'times acceleration' },
      { id: 'f', label: 'Force', emphasis: true, anchor: 'Force equals' },
    ],
    edges: [{ from: 'm', to: 'a', label: 'x' }, { from: 'a', to: 'f', label: '=' }],
  },
  {
    shape: 'focus', narration: 'Entropy is the number of ways a system can be arranged.',
    title: 'Entropy',
    nodes: [{ id: 'i', label: 'The number of ways a system can be arranged', anchor: 'the number of ways' }],
  },
  {
    shape: 'illustration',
    narration: 'The stomata on the underside of a leaf open to let carbon dioxide in.',
    title: 'Stomata, seen close up',
    imageBrief: { query: 'leaf stomata micrograph', kind: 'diagram', alt: 'stomata on a leaf surface' },
    nodes: [
      { id: 'g', label: 'Guard cells', anchor: 'the underside of a leaf' },
      { id: 'p', label: 'Pore', anchor: 'open to let' },
    ],
    caption: 'Each pore is bounded by two guard cells.',
  },
];
