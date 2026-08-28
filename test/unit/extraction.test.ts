import { describe, it, expect } from 'vitest';
import { readZipEntries } from '@infrastructure/extraction/ZipReader.js';
import { LanguageDetector } from '@infrastructure/extraction/LanguageDetector.js';
import { ExtractorRegistry } from '@infrastructure/extraction/ExtractorRegistry.js';
import { MagicByteSniffer } from '@infrastructure/extraction/TypeSniffer.js';
import type { ContentExtractorPort } from '@application/port/ContentExtractorPort.js';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** Builds a minimal but real zip so the reader is exercised, not mocked. */
function buildZip(files: { name: string; content: string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.content, 'utf8');
    const data = file.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(file.name, 'utf8');
    const method = file.store ? 0 : 8;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

describe('ZipReader', () => {
  it('lists entries with their sizes before inflating anything', async () => {
    const zip = buildZip([{ name: 'ppt/slides/slide1.xml', content: 'x'.repeat(5000) }]);
    const [entry] = await readZipEntries(zip);

    expect(entry!.name).toBe('ppt/slides/slide1.xml');
    expect(entry!.uncompressedSize).toBe(5000);
    // Sizes must be readable without expansion — that is what lets ArchiveGuard
    // reject a bomb before it does any damage.
    expect(entry!.compressedSize).toBeLessThan(5000);
  });

  it('inflates deflated entries correctly', async () => {
    const zip = buildZip([{ name: 'a.xml', content: '<t>hello world</t>' }]);
    const [entry] = await readZipEntries(zip);
    expect(entry!.read().toString('utf8')).toBe('<t>hello world</t>');
  });

  it('reads stored (uncompressed) entries', async () => {
    const zip = buildZip([{ name: 'b.xml', content: 'plain', store: true }]);
    const [entry] = await readZipEntries(zip);
    expect(entry!.read().toString('utf8')).toBe('plain');
  });

  it('reads several entries independently', async () => {
    const zip = buildZip([
      { name: 'one.xml', content: 'first' },
      { name: 'two.xml', content: 'second' },
      { name: 'three.xml', content: 'third' },
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.read().toString('utf8'))).toEqual(['first', 'second', 'third']);
  });

  it('rejects a file that is not a zip', async () => {
    await expect(readZipEntries(Buffer.from('not a zip at all'))).rejects.toThrow(/not a valid zip/i);
  });
});

describe('LanguageDetector', () => {
  const detector = new LanguageDetector();

  it('detects English', () => {
    expect(detector.detect(
      'Photosynthesis is the process by which green plants convert light energy into chemical energy.',
    )?.code).toBe('en');
  });

  it('detects Spanish', () => {
    expect(detector.detect(
      'La fotosíntesis es el proceso por el cual las plantas verdes convierten la luz en energía química.',
    )?.code).toBe('es');
  });

  it('returns undefined for a sample too short to be reliable', () => {
    expect(detector.detect('hello')).toBeUndefined();
    expect(detector.detect('')).toBeUndefined();
  });

  it('returns undefined for a language outside the supported set', () => {
    expect(detector.detect(
      'Die Photosynthese ist der Prozess bei dem grüne Pflanzen Lichtenergie in chemische Energie umwandeln.',
    )).toBeUndefined();
  });
});

describe('ExtractorRegistry', () => {
  const fake = (name: string, mime: string): ContentExtractorPort => ({
    name,
    supports: (m) => m === mime,
    extract: async () => { throw new Error('not called'); },
  });

  it('dispatches on sniffed type', () => {
    const registry = new ExtractorRegistry()
      .register(fake('pdf', 'application/pdf'))
      .register(fake('png', 'image/png'));

    expect(registry.resolve('image/png', { type: 'file', filename: 'a', mimeType: 'x', bytes: 1 })?.name).toBe('png');
  });

  it('returns undefined when nothing handles the type', () => {
    expect(new ExtractorRegistry().resolve('application/zip', { type: 'url', url: 'http://x' }))
      .toBeUndefined();
  });

  it('honours registration order, so a catch-all registered last cannot shadow', () => {
    const registry = new ExtractorRegistry()
      .register(fake('specific', 'application/pdf'))
      .register({ name: 'catch-all', supports: () => true, extract: async () => { throw new Error(''); } });

    expect(registry.resolve('application/pdf', { type: 'url', url: 'http://x' })?.name).toBe('specific');
  });
});

describe('MagicByteSniffer', () => {
  it('identifies by content, never by extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sniff-'));
    // A PNG signature in a file named .pdf.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
    const path = join(dir, 'lying-name.pdf');
    await writeFile(path, png);

    expect(await new MagicByteSniffer().sniff(path)).toBe('image/png');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for content it cannot identify', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sniff2-'));
    const path = join(dir, 'x.bin');
    await writeFile(path, Buffer.from('just some plain text, no signature'));

    expect(await new MagicByteSniffer().sniff(path)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
