import { open } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import type { TypeSniffer as TypeSnifferPort } from '@application/pipeline/stage/ValidateInputsStage.js';

/**
 * Magic bytes only — never the filename extension or the client-supplied
 * content type, both of which are attacker-controlled.
 */
export class MagicByteSniffer implements TypeSnifferPort {
  public async sniff(localPath: string): Promise<string | undefined> {
    const handle = await open(localPath, 'r');
    try {
      // 4100 bytes is what file-type documents as sufficient for every signature
      // it knows; reading the whole file to identify it would be wasteful.
      const buffer = Buffer.alloc(4100);
      const { bytesRead } = await handle.read(buffer, 0, 4100, 0);
      const detected = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
      return detected?.mime;
    } finally {
      await handle.close();
    }
  }
}
