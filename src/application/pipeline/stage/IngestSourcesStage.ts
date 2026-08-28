import type { PipelineStage } from '../PipelineStage.js';
import type { PipelineContext } from '../PipelineContext.js';
import type { StageName } from '../StageName.js';
import type { ContentExtractorPort } from '../../port/ContentExtractorPort.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { SourceOrigin } from '@domain/content/SourceDocument.js';
import type { ValidatedInput, IngestedSources } from './types.js';

export interface ExtractorRegistry {
  resolve(mimeType: string, origin: SourceOrigin): ContentExtractorPort | undefined;
}

/**
 * Every extracted chunk carries {sourceId, page|timestamp} — the substrate for
 * FR-13 and for the quiz's source_moment_seconds. Provenance is attached here or
 * it does not exist later.
 */
export class IngestSourcesStage implements PipelineStage<ValidatedInput, IngestedSources> {
  public readonly name: StageName = 'ingest';

  constructor(private readonly registry: ExtractorRegistry) {}

  public async execute(input: ValidatedInput, ctx: PipelineContext): Promise<IngestedSources> {
    const documents = [];
    let done = 0;

    for (const source of input.sources) {
      ctx.throwIfCancelled();

      const extractor = this.registry.resolve(source.sniffedMimeType, source.origin);
      if (!extractor) {
        throw new UnsupportedFormatError(
          `No extractor is registered for '${source.sniffedMimeType}'.`,
          { sniffed_type: source.sniffedMimeType },
        );
      }

      ctx.logger.debug({ sourceId: source.sourceId, extractor: extractor.name }, 'extracting');
      documents.push(await extractor.extract({
        sourceId: source.sourceId,
        origin: source.origin,
        ...(source.localPath !== undefined ? { localPath: source.localPath } : {}),
        sniffedMimeType: source.sniffedMimeType,
      }));

      done += 1;
      ctx.reportProgress(this.name, done / input.sources.length);
    }

    return { documents };
  }

}
