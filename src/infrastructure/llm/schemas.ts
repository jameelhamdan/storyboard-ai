/**
 * Response schemas handed to the model.
 *
 * A schema turns "the model returned something unparseable" from a runtime
 * surprise into a constraint the provider enforces — which is what makes a bad
 * generation a validation failure rather than an ugly video.
 */

import { DIAGRAM_SHAPES } from '@domain/script/DiagramShape.js';
import { GATES } from '@domain/quality/QualityScore.js';
import { PLAN_ISSUES } from '@domain/quality/PlanCritique.js';

/**
 * A scene's narration is a list of sentences, not one string.
 *
 * The distinction the list carries is what makes the narration teachable. Every
 * sentence used to need a citation, and the prompt forbade addressing the viewer
 * — which left a declarative restatement of a cited fact as the only admissible
 * sentence, and produced narration that reads as a compressed paraphrase of the
 * source. A `teach` sentence states no fact about the subject, carries no
 * citation, and is excluded from `traceability.json`, so the grounding guarantee
 * is unchanged while the writing has somewhere to go.
 */
export const scriptSchema = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sentences: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['assert', 'teach'],
                  description: 'assert states a fact from the material and needs citations; teach frames or connects and needs none.',
                },
                citations: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Chunk ids supporting this sentence. Required for assert, empty for teach.',
                },
              },
              required: ['text', 'kind', 'citations'],
            },
          },
          // An enum, not a sentence: a scene whose shape was described in prose
          // reliably came back as a title and a bullet list.
          visualIntent: { type: 'string', enum: [...DIAGRAM_SHAPES] },
          /**
           * Keep the previous scene's board and add to it, rather than wiping to
           * a new one. Requires the same visualIntent as the scene it continues.
           */
          continuesBoard: {
            type: 'boolean',
            description:
              'True to build on the previous scene\'s diagram instead of starting a new one. ' +
              'Only valid when visualIntent matches the previous scene\'s.',
          },
        },
        required: ['sentences', 'visualIntent'],
      },
    },
  },
  required: ['scenes'],
} as const;

export const quizSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          sceneIndex: { type: 'integer' },
        },
        required: ['question', 'answer', 'sceneIndex'],
      },
    },
  },
  required: ['questions'],
} as const;

/**
 * One note per gate, not one shared note.
 *
 * The prompt used to ask for `failReasons` while the schema enforced a single
 * `notes` string, so the adapter stamped the same sentence onto every gate —
 * including the passing ones. You can see it in the battery run's verdict, where
 * scene 1's G2 "passed" carries a note explaining why G1 and G3 failed. A retry
 * told about the wrong gate fixes the wrong thing.
 */
export const sceneJudgeSchema = {
  type: 'object',
  properties: {
    gates: {
      type: 'object',
      properties: Object.fromEntries(GATES.map((gate) => [gate, {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          note: { type: 'string', description: 'Why it failed. Empty when it passed.' },
        },
        required: ['passed'],
      }])),
      required: [...GATES],
    },
    holistic: { type: 'integer', description: '1-5. Reported, never gated on.' },
  },
  required: ['gates', 'holistic'],
} as const;

/**
 * The plan review's answer.
 *
 * `issues` carries a closed `kind` because that is what makes an objection
 * actionable — the rewrite needs to know whether to look at one scene or at the
 * whole scene list, and prose cannot be dispatched on. `approved` is the judge's
 * own call rather than something derived from `score`: the score drifts between
 * runs and is reported, never gated on.
 */
export const planJudgeSchema = {
  type: 'object',
  properties: {
    approved: { type: 'boolean', description: 'True only when there are no issues worth raising.' },
    score: { type: 'integer', description: '1-5, how well this plan teaches its material. Reported, never gated on.' },
    summary: { type: 'string', description: 'One sentence on the plan as a whole.' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...PLAN_ISSUES] },
          sceneIndex: { type: 'integer', description: 'The scene this is about. Omit for whole-plan issues.' },
          note: { type: 'string', description: 'What is wrong and what a student would fail to understand.' },
        },
        required: ['kind', 'note'],
      },
    },
  },
  required: ['approved', 'issues'],
} as const;

export const visionSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;
