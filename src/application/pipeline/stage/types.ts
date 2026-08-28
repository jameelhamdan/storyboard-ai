import type { SourceDocument, SourceOrigin } from '@domain/content/SourceDocument.js';
import type { ConsolidatedContent } from '@domain/content/ConsolidatedContent.js';
import type { NarrationScript } from '@domain/script/NarrationScript.js';
import type { VisualPlan } from '@domain/media/VisualPlan.js';
import type { Storyboard } from '@domain/script/Storyboard.js';
import type { SubtitleCue } from '@domain/media/SubtitleCue.js';
import type { QuizQuestion } from '@domain/quiz/QuizQuestion.js';
import type { QualityVerdict } from '@domain/quality/QualityVerdict.js';
import type { JobArtifacts } from '@domain/job/VideoJob.js';

/**
 * Each stage's output extends the previous one's, so the chain below *is* the
 * data-flow diagram: what a stage can read is exactly what the stages before it
 * produced, checked by the compiler rather than by convention.
 */

/** The raw request, already past transport validation. */
export interface SubmittedSource {
  readonly sourceId: string;
  readonly origin: SourceOrigin;
  readonly localPath?: string;
  readonly declaredMimeType?: string;
  readonly sizeBytes?: number;
}

export interface ValidatedInput {
  readonly sources: readonly (SubmittedSource & { readonly sniffedMimeType: string })[];
}

export interface IngestedSources {
  readonly documents: readonly SourceDocument[];
}

export interface TranscribedSources extends IngestedSources {
  readonly audioSecondsTranscribed: number;
}

/**
 * Every carry is a record of named fields, including this one — the consolidated
 * content used to travel as a bare domain object, which meant the checkpoint
 * codec had nothing to key it by and silently dropped it on resume.
 */
export interface ConsolidatedSources {
  readonly content: ConsolidatedContent;
}

/** The script plus the video's agreed visual design — both settled in one stage. */
export interface ScriptedContent extends ConsolidatedSources {
  readonly script: NarrationScript;
  readonly visualPlan: VisualPlan;
}

export interface StoryboardedContent extends ScriptedContent {
  readonly storyboard: Storyboard;
}

export interface JudgedStoryboard extends StoryboardedContent {
  readonly verdict: QualityVerdict;
}

export interface SynthesizedAudio extends JudgedStoryboard {
  readonly audioKey: string;
  readonly totalAudioMs: number;
}

export interface SubtitledVideo extends SynthesizedAudio {
  readonly cues: readonly SubtitleCue[];
  readonly subtitleKey: string;
}

export interface QuizzedVideo extends SubtitledVideo {
  readonly quiz: readonly QuizQuestion[];
}

export interface RenderedVideo extends QuizzedVideo {
  readonly segmentKeys: readonly string[];
  readonly renderWallSeconds: number;
}

export interface AssembledVideo extends RenderedVideo {
  readonly videoKey: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
}

/** What the worker hands back to the job. */
export interface FinalisedJob {
  readonly artifacts: JobArtifacts;
  readonly quiz: readonly QuizQuestion[];
  readonly verdict: QualityVerdict;
}
