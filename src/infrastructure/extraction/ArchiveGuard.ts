import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxCompressionRatio: number;
}

export interface ArchiveEntrySummary {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/**
 * DOCX and PPTX are zip containers, which makes them a decompression-bomb vector:
 * a 40KB upload can expand to gigabytes and take the worker down with it. All
 * three limits matter independently — entry count catches many small files, total
 * size catches one huge one, and the ratio catches the classic nested bomb that
 * passes both individually.
 */
export class ArchiveGuard {
  constructor(private readonly limits: ArchiveLimits) {}

  public assertSafe(filename: string, entries: readonly ArchiveEntrySummary[]): void {
    if (entries.length > this.limits.maxEntries) {
      throw UnsupportedFormatError.overLimit(
        `archive entry count in '${filename}'`, entries.length, this.limits.maxEntries,
      );
    }

    let uncompressed = 0;
    let compressed = 0;

    for (const entry of entries) {
      uncompressed += entry.uncompressedSize;
      compressed += entry.compressedSize;

      if (uncompressed > this.limits.maxUncompressedBytes) {
        throw UnsupportedFormatError.overLimit(
          `uncompressed size of '${filename}'`, uncompressed, this.limits.maxUncompressedBytes,
        );
      }

      // Zip-slip: an entry path that escapes the extraction directory.
      if (entry.name.includes('..') || entry.name.startsWith('/')) {
        throw new UnsupportedFormatError(
          `'${filename}' contains an entry with an unsafe path ('${entry.name}').`,
          { filename, entry: entry.name },
        );
      }
    }

    const ratio = compressed > 0 ? uncompressed / compressed : 0;
    if (ratio > this.limits.maxCompressionRatio) {
      throw UnsupportedFormatError.overLimit(
        `compression ratio of '${filename}'`, Math.round(ratio), this.limits.maxCompressionRatio,
      );
    }
  }
}
