import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  read(): Buffer;
}

/**
 * A minimal zip central-directory reader.
 *
 * Deliberately lazy: sizes are read from the directory *before* anything is
 * inflated, so ArchiveGuard can reject a decompression bomb without ever
 * expanding it. A library that returns entries already-inflated would have done
 * the damage before we got a chance to look.
 */
export async function readZipEntries(buffer: Buffer): Promise<readonly ZipEntry[]> {
  const eocd = findEndOfCentralDirectory(buffer);
  if (!eocd) throw new Error('Not a valid zip archive: no end-of-central-directory record.');

  const entries: ZipEntry[] = [];
  let offset = eocd.centralDirectoryOffset;

  for (let i = 0; i < eocd.entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break; // central file header signature

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      read(): Buffer {
        // The local header's name/extra lengths differ from the central
        // directory's, so the data offset must be computed from the local header.
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);

        if (compressionMethod === 0) return Buffer.from(raw);
        if (compressionMethod === 8) return inflateRawSync(raw);
        throw new Error(`Unsupported zip compression method ${compressionMethod} for '${name}'.`);
      },
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): { entryCount: number; centralDirectoryOffset: number } | undefined {
  // The EOCD is at the end but may be followed by a variable-length comment, so
  // scan backwards over the maximum comment size rather than assuming it is last.
  const maxCommentLength = 0xffff;
  const start = Math.max(0, buffer.length - maxCommentLength - 22);

  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return {
        entryCount: buffer.readUInt16LE(i + 10),
        centralDirectoryOffset: buffer.readUInt32LE(i + 16),
      };
    }
  }
  return undefined;
}
