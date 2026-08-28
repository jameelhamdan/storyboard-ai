import type { SourceDocument, SourceOrigin } from '@domain/content/SourceDocument.js';

export interface ExtractionInput {
  readonly sourceId: string;
  readonly origin: SourceOrigin;
  /** Local path to the fetched bytes, or undefined for URL sources handled in-adapter. */
  readonly localPath?: string;
  readonly sniffedMimeType?: string;
}

/**
 * One adapter per format. Adapters register themselves with the registry and it
 * dispatches on sniffed type — adding PPTX support is a new file plus a
 * registration, never an edit to a switch statement.
 */
export interface ContentExtractorPort {
  readonly name: string;
  supports(mimeType: string, origin: SourceOrigin): boolean;
  extract(input: ExtractionInput): Promise<SourceDocument>;
}
