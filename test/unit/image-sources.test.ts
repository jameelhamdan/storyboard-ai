import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { CompositeImageSource } from '@infrastructure/image/CompositeImageSource.js';
import { ImageSourceRegistry } from '@infrastructure/image/ImageSourceRegistry.js';
import { ImageSourcePolicy } from '@domain/policy/ImageSourcePolicy.js';
import type { ImageSourceId } from '@domain/media/ImageSourceId.js';
import { UnsplashImageSource } from '@infrastructure/image/UnsplashImageSource.js';
import { WikimediaImageSource } from '@infrastructure/image/WikimediaImageSource.js';
import { inlineImage } from '@infrastructure/image/inlineImage.js';
import type { ImageSourcePort, ImageQuery } from '@application/port/ImageSourcePort.js';
import type { SceneImage } from '@domain/media/SceneImage.js';
import { createLogger } from '@infrastructure/observability/logger.js';

const logger = createLogger({ level: 'silent', redactPaths: [] });

afterEach(() => vi.unstubAllGlobals());

const jpeg = async (width = 2400, height = 1600) =>
  sharp({ create: { width, height, channels: 3, background: '#808080' } }).jpeg().toBuffer();

const image = async (): Promise<SceneImage> => inlineImage({
  bytes: await jpeg(),
  alt: 'x',
  attribution: { author: 'A', sourceName: 'S', sourceUrl: 'u', licence: 'l' },
  source: 'wikimedia',
});

/** A source that records what it was asked and answers as instructed. */
function fake(
  id: ImageSourceId,
  answer: 'found' | 'nothing' | 'throws',
): ImageSourcePort & { calls: ImageQuery[] } {
  const calls: ImageQuery[] = [];
  return {
    id,
    calls,
    async find(query) {
      calls.push(query);
      if (answer === 'throws') throw new Error(`${id} is down`);
      return answer === 'found' ? image() : undefined;
    },
  };
}

/** The deployment's capability: whichever sources have a credential. */
function finderOver(...sources: readonly ImageSourcePort[]): CompositeImageSource {
  const registry = new ImageSourceRegistry();
  for (const source of sources) registry.register(source.id, source);
  return new CompositeImageSource(registry, new ImageSourcePolicy(), logger);
}

describe('inlineImage', () => {
  /**
   * The board is 1280x720 and the plate is a fraction of it. A 2400px original
   * inlined verbatim is megabytes of base64 that Chromium decodes on every frame
   * of the scene.
   */
  it('caps the size and re-encodes to webp', async () => {
    const result = await image();
    expect(result.width).toBeLessThanOrEqual(1100);
    expect(result.dataUri.startsWith('data:image/webp;base64,')).toBe(true);
  });

  it('keeps the aspect ratio, so the plate picks the right layout', async () => {
    const portrait = await inlineImage({
      bytes: await jpeg(900, 1600),
      alt: 'x',
      attribution: { author: 'A', sourceName: 'S', sourceUrl: 'u', licence: 'l' },
      source: 'wikimedia',
    });
    expect(portrait.isPortrait).toBe(true);
  });

  /** Every source we search requires credit, so it is not a separable field. */
  it('refuses an image with no author', async () => {
    await expect(inlineImage({
      bytes: await jpeg(),
      alt: 'x',
      attribution: { author: '  ', sourceName: 'S', sourceUrl: 'u', licence: 'l' },
      source: 'wikimedia',
    })).rejects.toThrow(/author and source/);
  });
});

describe('CompositeImageSource', () => {
  /**
   * Routing, not ranking. Stock libraries have no scientific diagrams and
   * Commons has few good photographs, so which source is asked *first* is the
   * difference between the right image and a stock photo of a laboratory.
   */
  it('asks Wikimedia first for a diagram', async () => {
    const wikimedia = fake('wikimedia', 'found');
    const unsplash = fake('unsplash', 'found');

    await finderOver(unsplash, wikimedia).find({ query: 'krebs cycle', kind: 'diagram' });

    expect(wikimedia.calls).toHaveLength(1);
    expect(unsplash.calls).toHaveLength(0);
  });

  it('asks the stock libraries first for a photograph', async () => {
    const wikimedia = fake('wikimedia', 'found');
    const unsplash = fake('unsplash', 'found');

    await finderOver(wikimedia, unsplash).find({ query: 'volcano', kind: 'photo' });

    expect(unsplash.calls).toHaveLength(1);
    expect(wikimedia.calls).toHaveLength(0);
  });

  /**
   * The job's list is a request, and the deployment's registry is the
   * capability. Asking for a library with no credential is an ordinary outcome
   * — it simply is not asked — which is what keeps `image_sources` from being a
   * field a caller has to keep in sync with the server's .env.
   */
  it('asks only the sources the job permits', async () => {
    const wikimedia = fake('wikimedia', 'found');
    const unsplash = fake('unsplash', 'found');

    await finderOver(wikimedia, unsplash)
      .find({ query: 'volcano', kind: 'photo', sources: ['wikimedia'] });

    expect(wikimedia.calls).toHaveLength(1);
    expect(unsplash.calls).toHaveLength(0);
  });

  it('ignores a permitted source the deployment cannot reach', async () => {
    const wikimedia = fake('wikimedia', 'found');

    const found = await finderOver(wikimedia)
      .find({ query: 'volcano', kind: 'photo', sources: ['unsplash', 'wikimedia'] });

    expect(found).toBeDefined();
    expect(wikimedia.calls).toHaveLength(1);
  });

  it('finds nothing, without calling anything, when the intersection is empty', async () => {
    const wikimedia = fake('wikimedia', 'found');

    const found = await finderOver(wikimedia)
      .find({ query: 'volcano', kind: 'photo', sources: ['pexels'] });

    expect(found).toBeUndefined();
    expect(wikimedia.calls).toHaveLength(0);
  });

  /** Two of three sources working is a working feature, not a failed board. */
  it('skips a source that throws and uses the next one', async () => {
    const broken = fake('unsplash', 'throws');
    const working = fake('pexels', 'found');

    expect(await finderOver(broken, working).find({ query: 'volcano', kind: 'photo' }))
      .toBeDefined();
    expect(working.calls).toHaveLength(1);
  });

  it('returns undefined when nobody has anything, rather than throwing', async () => {
    const finder = finderOver(fake('unsplash', 'nothing'), fake('pexels', 'nothing'));
    expect(await finder.find({ query: 'nothing at all', kind: 'photo' })).toBeUndefined();
  });

  /**
   * The retry path asks the same question again, and the answer will not have
   * changed within one job — including when it was "nothing".
   */
  it('caches both hits and misses', async () => {
    const source = fake('unsplash', 'nothing');
    const finder = finderOver(source);

    await finder.find({ query: 'same thing', kind: 'photo' });
    await finder.find({ query: 'Same Thing', kind: 'photo' });

    expect(source.calls).toHaveLength(1);
  });

  /**
   * Two jobs asking the same question with different libraries permitted can
   * legitimately get different pictures, so the permitted set is part of the key.
   */
  it('does not serve a cached answer to a job with different sources permitted', async () => {
    const wikimedia = fake('wikimedia', 'nothing');
    const unsplash = fake('unsplash', 'nothing');
    const finder = finderOver(wikimedia, unsplash);

    await finder.find({ query: 'volcano', kind: 'photo', sources: ['unsplash'] });
    await finder.find({ query: 'volcano', kind: 'photo', sources: ['wikimedia'] });

    expect(unsplash.calls).toHaveLength(1);
    expect(wikimedia.calls).toHaveLength(1);
  });

  it('reports which libraries this deployment can reach', () => {
    expect(finderOver(fake('pexels', 'found'), fake('wikimedia', 'found')).available)
      .toEqual(['pexels', 'wikimedia']);
  });
});

/**
 * Ordering is a judgement about the material — which library answers which kind
 * of question — so it is a domain policy rather than a name check inside the
 * adapter that iterates the sources. That check was the reason a fifth source
 * could not be added without editing the composite.
 */
describe('ImageSourcePolicy', () => {
  const policy = new ImageSourcePolicy();
  const all: ImageSourceId[] = ['wikimedia', 'unsplash', 'pexels', 'web_search'];

  it('leads with the reference library for a diagram', () => {
    expect(policy.order('diagram', all).slice(0, 2)).toEqual(['wikimedia', 'web_search']);
  });

  it('leads with the stock libraries for a photo', () => {
    expect(policy.order('photo', all).slice(0, 2)).toEqual(['unsplash', 'pexels']);
  });

  /** The open web is the only source that cannot state a licence. */
  it('puts the open web behind every curated library', () => {
    const order = policy.order('photo', all);
    expect(order.indexOf('web_search')).toBeGreaterThan(order.indexOf('pexels'));
  });

  it('returns only what was allowed', () => {
    expect(policy.order('diagram', ['pexels', 'unsplash'])).toEqual(['unsplash', 'pexels']);
  });

  it('is empty when nothing is allowed', () => {
    expect(policy.order('photo', [])).toEqual([]);
  });
});

describe('UnsplashImageSource', () => {
  it('declines diagram queries rather than returning a plausible-looking photo', async () => {
    const source = new UnsplashImageSource({ accessKey: 'k', requestTimeoutMs: 1000 }, logger);
    vi.stubGlobal('fetch', async () => { throw new Error('must not be called'); });
    expect(await source.find({ query: 'krebs cycle', kind: 'diagram' })).toBeUndefined();
  });

  it('sends the key as a Client-ID and fires the licence-required download trigger', async () => {
    const seen: string[] = [];
    const bytes = await jpeg(800, 600);

    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const href = String(url);
      seen.push(href);

      if (href.includes('/search/photos')) {
        expect((init.headers as Record<string, string>).authorization).toBe('Client-ID k');
        return new Response(JSON.stringify({
          results: [{
            alt_description: 'a volcano',
            urls: { regular: 'https://images.example/photo.jpg' },
            links: { html: 'https://unsplash.com/p/1', download_location: 'https://api.example/d/1' },
            user: { name: 'A Photographer' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === 'https://images.example/photo.jpg') return new Response(bytes, { status: 200 });
      return new Response('', { status: 200 });
    });

    const source = new UnsplashImageSource({
      accessKey: 'k', requestTimeoutMs: 1000, baseUrl: 'https://api.example',
    }, logger);

    const found = await source.find({ query: 'volcano', kind: 'photo' });

    expect(found?.attribution).toMatchObject({ author: 'A Photographer', sourceName: 'Unsplash' });
    expect(found?.credit).toContain('A Photographer');
    // Trigger is fired and not awaited, so give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toContain('https://api.example/d/1');
  });
});

describe('WikimediaImageSource', () => {
  /**
   * Commons returns the credit as an HTML link. A board displays it as text, so
   * the tags come off — running someone else's markup on a rendered frame is not
   * a thing this service does.
   */
  /**
   * Observed on a real search: Commons puts the same name in a `title`
   * attribute and in the link text, so a naive strip printed "Unknown author
   * Unknown author" under the picture.
   */
  it('collapses a credit Commons repeated in its own markup', async () => {
    const bytes = await jpeg(400, 300);
    vi.stubGlobal('fetch', async (url: URL | string) => {
      if (String(url).includes('api.php')) {
        return new Response(JSON.stringify({
          query: {
            pages: {
              '1': {
                title: 'File:X.jpg',
                imageinfo: [{
                  thumburl: 'https://upload.example/x.jpg',
                  extmetadata: {
                    Artist: { value: '<a title="Unknown author">Unknown author</a>' },
                    LicenseShortName: { value: 'Public domain' },
                  },
                }],
              },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(bytes, { status: 200 });
    });

    const source = new WikimediaImageSource({
      requestTimeoutMs: 1000, userAgent: 'test/1.0', baseUrl: 'https://commons.example',
    });
    const found = await source.find({ query: 'x', kind: 'diagram' });
    expect(found?.attribution.author).toBe('Unknown author');
  });

  it('strips the HTML Commons wraps its credit in', async () => {
    const bytes = await jpeg(800, 600);
    vi.stubGlobal('fetch', async (url: URL | string) => {
      if (String(url).includes('api.php')) {
        return new Response(JSON.stringify({
          query: {
            pages: {
              '1': {
                title: 'File:Stomata.jpg',
                imageinfo: [{
                  thumburl: 'https://upload.example/thumb.jpg',
                  descriptionurl: 'https://commons.example/File:Stomata.jpg',
                  extmetadata: {
                    Artist: { value: '<a href="/wiki/User:Bob" title="x">Bob</a>' },
                    LicenseShortName: { value: 'CC BY-SA 4.0' },
                    ImageDescription: { value: '<p>Stomata on a leaf</p>' },
                  },
                }],
              },
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(bytes, { status: 200 });
    });

    const source = new WikimediaImageSource({
      requestTimeoutMs: 1000, userAgent: 'test/1.0', baseUrl: 'https://commons.example',
    });
    const found = await source.find({ query: 'stomata', kind: 'diagram' });

    expect(found?.attribution.author).toBe('Bob');
    expect(found?.attribution.licence).toBe('CC BY-SA 4.0');
    expect(found?.alt).toBe('Stomata on a leaf');
  });
});
