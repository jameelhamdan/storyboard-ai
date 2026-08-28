/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  EDIT THIS FILE to change what the end-to-end test generates.
 *
 *  Everything here is plain data. Change the source material, the language, the
 *  student context or the preset, then run:
 *
 *      npm run e2e
 *
 *  With LLM_DRIVER=stub (the default) this costs nothing and still produces a
 *  real MP4. Set LLM_DRIVER=openai and TTS_DRIVER=elevenlabs in .env to run it
 *  against the real models.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface E2eScenario {
  /** Shown in the run header. */
  readonly name: string;
  /**
   * The material the video is generated *from*. Source-lock means nothing in
   * the video may come from anywhere else — so this text is the whole world the
   * model is allowed to draw on.
   *
   * Use `sourceFile` instead to point at a real PDF/DOCX/PPTX on disk.
   */
  readonly sourceText?: string;
  readonly sourceFile?: string;
  readonly outputLanguage: 'en' | 'es';
  readonly qualityPreset?: 'draft' | 'standard' | 'high' | 'vertical';
  /** How the video reads and looks — a key from config/styles.yaml. */
  readonly style?: string;
  /** Free-text steer for this run, exactly as the API's `direction` field. */
  readonly direction?: string;
  readonly voice?: string;
  readonly targetDurationSeconds?: number;
  readonly studentContext?: {
    readonly level?: 'primary' | 'secondary' | 'high_school' | 'bachelor' | 'master' | 'doctorate';
    readonly goal?: string;
    readonly instructions?: string;
    readonly weaknesses?: readonly string[];
  };
}

/** ── The default run. Change freely. ─────────────────────────────────────── */
export const DEFAULT_SCENARIO: E2eScenario = {
  name: 'Photosynthesis — bachelor, exam prep',

  sourceText: `
Photosynthesis is the process by which green plants, algae and some bacteria convert light
energy into chemical energy stored in glucose. It takes place in the chloroplast, an
organelle bounded by a double membrane and containing stacks of flattened sacs called
thylakoids. Photosynthesis is divided into two stages: the light-dependent reactions and
the Calvin cycle.

The light-dependent reactions occur in the thylakoid membrane. Embedded in that membrane
are two protein complexes, photosystem II and photosystem I, each containing chlorophyll.
Chlorophyll absorbs photons most strongly in the blue and red regions of the visible
spectrum, and reflects green light, which is why leaves appear green. The absorbed energy
excites electrons to a higher energy state.

These excited electrons pass along an electron transport chain from photosystem II to
photosystem I. As they move, protons are pumped from the stroma into the thylakoid lumen,
building an electrochemical gradient. Protons flowing back down that gradient through the
enzyme ATP synthase drive the production of ATP, a process called photophosphorylation. At
the end of the chain, NADP+ is reduced to NADPH. The electrons lost by photosystem II are
replaced by splitting water molecules, a reaction called photolysis, and oxygen is released
as a by-product.

The Calvin cycle takes place in the stroma and does not require light directly, although it
depends on the products of the light reactions. It uses the ATP and NADPH to fix carbon
dioxide into three-carbon sugars. The enzyme RuBisCO catalyses the first step, attaching
carbon dioxide to a five-carbon acceptor called ribulose bisphosphate. The resulting
six-carbon compound is unstable and immediately splits into two molecules of
3-phosphoglycerate. These are reduced to glyceraldehyde 3-phosphate using ATP and NADPH.
Most of the glyceraldehyde 3-phosphate is recycled to regenerate ribulose bisphosphate, and
six turns of the cycle are needed to produce one molecule of glucose.

The overall equation is six carbon dioxide plus six water, in the presence of light, yielding
one glucose and six oxygen. Several factors limit the rate of photosynthesis: light
intensity, carbon dioxide concentration, and temperature. At low light intensity the rate
rises in proportion to the light available; beyond a certain point another factor becomes
limiting and the rate plateaus. Temperature affects the enzymes of the Calvin cycle, so the
rate falls sharply above roughly forty degrees celsius as those enzymes denature.

Photosynthesis is the entry point for almost all energy in the biosphere. The chemical energy
it stores in glucose is what cellular respiration later releases, and the oxygen it produces
sustains aerobic life.
`.trim(),

  outputLanguage: 'en',
  qualityPreset: 'standard',
  targetDurationSeconds: 150,

  studentContext: {
    level: 'bachelor',
    goal: 'exam preparation',
    instructions: 'Emphasise the role of ATP and NADPH as the link between the two stages.',
  },
};

/**
 * Extra scenarios. Run one with `npm run e2e -- --scenario spanish`.
 * These exist to make the two things most likely to break easy to check:
 * a different output language, and a real file rather than inline text.
 */
export const SCENARIOS: Record<string, E2eScenario> = {
  default: DEFAULT_SCENARIO,

  /**
   * Process-and-cycle coverage, paired with `default`.
   *
   * Chosen because it states both relationships explicitly and separately: a
   * linear chain (glycolysis leads to pyruvate, which enters the Krebs cycle)
   * and a closed loop that returns to its start (oxaloacetate is regenerated).
   * A model that cannot tell `sc-flow` from `sc-cycle` will visibly pick wrong
   * here, whereas on a passage that merely lists steps both look defensible.
   *
   * The causal verbs are deliberate. Grounding rule G2 only permits a drawn
   * relationship where the source states one, so "leads to", "produces" and
   * "is regenerated" are what make a non-bullet-list component legitimate.
   */

  /**
   * Diagram-dense coverage, from software engineering rather than biology.
   *
   * Home networking is chosen because almost every paragraph has an explicit
   * *shape*: a packet's path is a flow, private versus public addressing is a
   * comparison, a routing table is a grid, the address hierarchy is a tree, and
   * NAT is a translation across a boundary. A model that defaults to bullet
   * lists will visibly waste this material, which makes it a good test of
   * whether the storyboard prompt is actually working.
   *
   * The numbers are written as digits here; text normalisation converts them to
   * the spoken form before the storyboard sees them, so anchors resolve against
   * "one nine two dot one six eight" rather than "192.168".
   */
  /**
   * Cycle-and-parts coverage — the shapes the other scenarios do not force.
   *
   * Chosen because the source states a genuine closed loop in words ("the cell
   * arrives back at its starting state", "described as a cycle rather than as
   * two separate events"), which is what makes an `sc-cycle` legitimate under
   * grounding rule G2 rather than an invented relationship. It also names four
   * discrete components, which is the cleanest `parts` material available.
   *
   * The numbers are load-bearing for a different reason: 3.7 volts, 11.1 volts,
   * 80 percent and 500 cycles all pass through text normalisation into spoken
   * form before the storyboard sees them, so anchors must resolve against
   * "three point seven volts" rather than "3.7". With OpenAI TTS those timings
   * are recovered by transcribing the audio, which makes this the sharpest test
   * of the whole normalise -> speak -> transcribe -> anchor chain.
   */
  battery: {
    name: 'Lithium-ion battery — cycle, parts and numbers',
    outputLanguage: 'en',
    qualityPreset: 'standard',
    style: 'explainer',
    direction: 'Show the charge and discharge as one loop, not two lists.',
    targetDurationSeconds: 60,
    studentContext: {
      level: 'high_school',
      goal: 'understanding how a rechargeable battery actually works',
      instructions: 'keep it concrete; the reader has not studied chemistry',
    },
    sourceText: `A lithium-ion battery stores energy by moving lithium ions back and forth between two electrodes. Nothing is consumed and nothing is created. The same ions travel one way while the battery charges and the other way while it discharges, which is why the cell can be used again and again.

The cell has four named parts. The anode is the negative electrode and is made of graphite. The cathode is the positive electrode and is made of a lithium metal oxide. The electrolyte is a liquid that fills the space between them and carries lithium ions across. The separator is a thin porous sheet that sits between the two electrodes; it lets ions pass through but blocks electrons, which prevents a short circuit.

When the battery charges, the charger pushes electrons into the anode. Lithium ions leave the cathode, cross the electrolyte, pass through the separator, and lodge between the layers of graphite in the anode. The anode now holds the stored energy. Charging therefore moves lithium from the cathode to the anode.

When the battery discharges, the process reverses. Lithium ions leave the anode and travel back through the electrolyte to the cathode. At the same time electrons leave the anode and travel through the external circuit, because the separator blocks them from taking the shortcut. That flow of electrons through the circuit is the current that powers the device. Discharging therefore moves lithium from the anode back to the cathode.

The two directions form a closed loop. Charging moves lithium one way, discharging returns it, and the cell arrives back at its starting state. This is why the process is described as a cycle rather than as two separate events.

A single cell produces about 3.7 volts. Devices that need more voltage connect several cells in series, so a laptop pack of three cells in series supplies about 11.1 volts.

Cells lose capacity as they age. A typical lithium-ion cell retains about 80 percent of its original capacity after 500 full charge cycles. Capacity fades because a thin layer builds up on the anode surface over time, and because repeated expansion of the graphite gradually damages its structure. Heat accelerates both effects, so a cell kept hot ages faster than one kept cool.

Charging speed is limited by how quickly lithium can enter the anode. Pushing charge in faster than the graphite can absorb it causes lithium to plate as metal on the anode surface instead of lodging between the layers. Plated lithium does not return to the cathode on discharge, so the capacity it represents is lost permanently. This is why fast charging slows down as a battery approaches full.`,
  },

  routing: {
    name: 'IP routing in home networks — diagram-dense',
    outputLanguage: 'en',
    qualityPreset: 'standard',
    studentContext: {
      level: 'bachelor',
      goal: 'understanding how a home network reaches the internet',
      instructions: 'favour diagrams over prose; the reader is a visual learner',
    },
    sourceText: `
Every device on a home network needs an address, and every packet leaving that network needs a route.
Understanding how those two things fit together explains almost everything about home networking.

Addresses come in two kinds. A private address, such as 192.168.1.14, is valid only inside the home
network, and the same private address may be in use in millions of other homes at the same time. A
public address, assigned by the internet service provider, is unique across the entire internet.
A home is typically given exactly one public address, while every device inside it holds its own
private address. This difference is the reason translation is necessary.

When a device joins the network it does not choose its own address. It broadcasts a request, and the
router answers using the Dynamic Host Configuration Protocol. The router leases the device a private
address from a pool, and tells it two further things: the subnet mask, which defines where the local
network ends, and the default gateway, which is the address of the router itself.

The subnet mask is what lets a device decide, for every packet it sends, whether the destination is
local or remote. The device compares the destination address against its own using the mask. If the
network portions match, the destination is on the same network and the packet is sent directly to it.
If they differ, the destination is remote, and the device sends the packet to the default gateway
instead. This single comparison is made for every packet, and it is the whole of the routing decision
on an ordinary device.

The router keeps a routing table, which lists destination networks alongside the interface each one
is reached through. When a packet arrives, the router matches the destination against the table and
forwards the packet out of the matching interface. A default route, written as 0.0.0.0/0, matches any
destination that no other entry covers, and it points at the internet service provider. Most traffic
leaving a home takes this default route.

Before the packet leaves, the router rewrites it. Network Address Translation replaces the private
source address with the single public address, and records the substitution in a translation table so
that the reply can be matched back to the device that asked for it. The reply arrives addressed to
the public address, the router consults its translation table, rewrites the destination back to the
private address, and delivers it. Without this table the router would have no way to know which
device a reply belonged to.
`,
  },

  respiration: {
    name: 'Cellular respiration — process and cycle',
    outputLanguage: 'en',
    qualityPreset: 'standard',
    studentContext: { level: 'bachelor', goal: 'exam preparation' },
    sourceText: `
Cellular respiration is the process by which cells release energy from glucose and store it as
adenosine triphosphate. It proceeds in three stages, and each stage leads directly into the next.

The first stage is glycolysis, which takes place in the cytoplasm. Glycolysis breaks one molecule of
glucose into two molecules of pyruvate. This stage does not require oxygen, and it produces a small
net yield of two adenosine triphosphate molecules. The pyruvate produced by glycolysis then moves
into the mitochondrion, where the second stage begins.

The second stage is the Krebs cycle, which occurs in the mitochondrial matrix. It is a closed loop:
pyruvate is first converted to acetyl coenzyme A, which combines with oxaloacetate to form citrate.
Citrate is then converted to isocitrate, and a series of reactions releases carbon dioxide and
regenerates oxaloacetate. Because oxaloacetate is regenerated at the end of every turn, the cycle
returns to its starting point and can run again. Each turn of the cycle produces electron carriers
rather than large amounts of adenosine triphosphate directly.

The third stage is the electron transport chain, located in the inner mitochondrial membrane. The
electron carriers produced by the Krebs cycle donate electrons to this chain. As electrons pass along
the chain, protons are pumped across the membrane, and the resulting gradient drives the synthesis of
adenosine triphosphate. Oxygen is the final electron acceptor, and it combines with electrons and
protons to form water. Without oxygen the chain cannot run, and the cell must fall back on anaerobic
pathways that yield far less energy.

When oxygen is absent, cells fall back on fermentation. In lactic acid fermentation, pyruvate is
converted directly into lactate, which regenerates the carriers that glycolysis needs and allows
glycolysis to continue. In alcoholic fermentation, yeast converts pyruvate into ethanol and carbon
dioxide instead. Neither pathway produces further adenosine triphosphate of its own; both exist only
to keep glycolysis running when the electron transport chain has stalled.

The three aerobic stages are therefore tightly coupled. Glycolysis supplies the pyruvate that feeds
the Krebs cycle, the Krebs cycle supplies the electron carriers that feed the electron transport
chain, and the electron transport chain regenerates the carriers that glycolysis and the Krebs cycle
both depend on. A blockage at any stage halts the stages upstream of it, which is why respiratory
poisons that inhibit a single enzyme in the chain are lethal so quickly.

In total, aerobic respiration of one glucose molecule yields roughly thirty-six molecules of
adenosine triphosphate, whereas anaerobic respiration yields only two. This difference is why
organisms that depend on sustained energy output require a continuous supply of oxygen.
`,
  },

  spanish: {
    ...DEFAULT_SCENARIO,
    name: 'Photosynthesis — Spanish output from English source',
    outputLanguage: 'es',
    // The source stays English on purpose: this exercises translation while the
    // citation still points at the original-language chunk.
    studentContext: { level: 'high_school', goal: 'quick review' },
  },

  short: {
    ...DEFAULT_SCENARIO,
    name: 'Photosynthesis — minimum length, draft preset',
    qualityPreset: 'draft',
    targetDurationSeconds: 120,
  },
};
