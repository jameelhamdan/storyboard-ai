import type { ContentExtractorPort } from '@application/port/ContentExtractorPort.js';
import type { ExtractorRegistry as ExtractorRegistryPort } from '@application/pipeline/stage/IngestSourcesStage.js';
import type { SourceOrigin } from '@domain/content/SourceDocument.js';

/**
 * Adapters register themselves and this dispatches on sniffed type. Adding a
 * format is a new file plus a registration — there is no switch statement to
 * edit, which is the open/closed rule made concrete rather than asserted.
 */
export class ExtractorRegistry implements ExtractorRegistryPort {
  private readonly extractors: ContentExtractorPort[] = [];

  public register(extractor: ContentExtractorPort): this {
    this.extractors.push(extractor);
    return this;
  }

  public resolve(mimeType: string, origin: SourceOrigin): ContentExtractorPort | undefined {
    return this.extractors.find((e) => e.supports(mimeType, origin));
  }

  public get registered(): readonly string[] {
    return this.extractors.map((e) => e.name);
  }
}
