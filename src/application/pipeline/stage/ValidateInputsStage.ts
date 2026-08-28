import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { SubmittedSource, ValidatedInput } from './types.js';

export interface TypeSniffer {
  /** Magic bytes, never the filename extension or the client-supplied type. */
  sniff(localPath: string): Promise<string | undefined>;
}

/**
 * Text has no magic bytes, so it can only be identified by what the client said
 * it was. That is safe here and nowhere else: text has no executable
 * interpretation, so a mislabelled binary produces unreadable characters that
 * the content thresholds reject — not code that runs.
 */
const SNIFFLESS_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain', 'text/markdown', 'text/x-markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg',
]);

/**
 * Runs before anything touches the input, and rejects with UNSUPPORTED_FORMAT
 * rather than failing deeper in the pipeline where the diagnosis is worse and the
 * money is already spent.
 */
export class ValidateInputsStage implements PipelineStage<readonly SubmittedSource[], ValidatedInput> {
  public readonly name: StageName = 'validate';

  constructor(private readonly sniffer: TypeSniffer) {}

  public async execute(sources: readonly SubmittedSource[], ctx: PipelineContext): Promise<ValidatedInput> {
    const limits = ctx.config.input;

    if (sources.length === 0) {
      throw new UnsupportedFormatError('No sources were supplied.');
    }
    if (sources.length > limits.maxSourcesPerRequest) {
      throw UnsupportedFormatError.overLimit('source count', sources.length, limits.maxSourcesPerRequest);
    }

    const totalBytes = sources.reduce((t, s) => t + (s.sizeBytes ?? 0), 0);
    if (totalBytes > limits.maxRequestBytes) {
      throw UnsupportedFormatError.overLimit('total request size in bytes', totalBytes, limits.maxRequestBytes);
    }

    const validated: (SubmittedSource & { sniffedMimeType: string })[] = [];

    for (const source of sources) {
      ctx.throwIfCancelled();

      if (source.sizeBytes !== undefined && source.sizeBytes > limits.maxFileBytes) {
        throw UnsupportedFormatError.overLimit(
          `file size for '${this.label(source)}'`, source.sizeBytes, limits.maxFileBytes,
        );
      }

      // URL and YouTube sources are validated by SafeHttpClient at fetch time —
      // there are no local bytes to sniff yet.
      if (source.origin.type !== 'file') {
        validated.push({ ...source, sniffedMimeType: 'text/html' });
        continue;
      }

      if (!source.localPath) {
        throw new UnsupportedFormatError(`File source '${this.label(source)}' has no readable content.`);
      }

      const sniffed = await this.sniffer.sniff(source.localPath);
      const declared = source.declaredMimeType?.split(';')[0]?.trim();

      const resolved = sniffed
        ?? (declared && SNIFFLESS_TYPES.has(declared) ? declared : undefined);

      if (!resolved || !SUPPORTED_MIME_TYPES.has(resolved)) {
        throw UnsupportedFormatError.sniffedType(this.label(source), sniffed ?? declared);
      }

      validated.push({ ...source, sniffedMimeType: resolved });
    }

    ctx.logger.info({ count: validated.length, totalBytes }, 'inputs validated');
    return { sources: validated };
  }

  private label(source: SubmittedSource): string {
    return source.origin.type === 'file' ? source.origin.filename : source.origin.url;
  }

}
