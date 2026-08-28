import { describe, it, expect, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { DuckDuckGoSearch } from '@infrastructure/search/DuckDuckGoSearch.js';
import { OpenverseImageSource } from '@infrastructure/image/OpenverseImageSource.js';

afterEach(() => vi.unstubAllGlobals());

const UA = 'test/1.0';

const resultPage = (results: { href: string; title: string; snippet: string }[]) => `
<html><body>
${results.map((r) => `
  <div class="result results_links">
    <a class="result__a" href="${r.href}">${r.title}</a>
    <a class="result__snippet">${r.snippet}</a>
  </div>`).join('')}
</body></html>`;

const wrapped = (url: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&rut=abc`;

/**
 * The option that makes research usable without signing up for anything. It
 * parses a page meant for a browser, so it is the driver that degrades rather
 * than the one that guarantees.
 */
describe('DuckDuckGoSearch', () => {
  const search = () => new DuckDuckGoSearch({
    requestTimeoutMs: 5000, userAgent: UA, baseUrl: 'https://ddg.example',
  });

  it('needs no credential, and identifies itself', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      seen.push(init);
      return new Response(resultPage([
        { href: wrapped('https://example.org/heart'), title: 'The heart', snippet: 'How it pumps' },
      ]), { status: 200 });
    });

    await search().search({ query: 'heart', limit: 3 });

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(UA);
    expect(JSON.stringify(headers)).not.toMatch(/authorization|api.?key|token/i);
  });

  /**
   * `cleveland clinic` in a citation is worth something; `duckduckgo.com/l/` is
   * worth nothing — and unwrapping here spares the SSRF guard a hop.
   */
  it('unwraps the redirect so a citation names the real source', async () => {
    vi.stubGlobal('fetch', async () => new Response(resultPage([
      { href: wrapped('https://my.clinic.example/heart'), title: 'Blood flow', snippet: 'A series' },
    ]), { status: 200 }));

    const [hit] = await search().search({ query: 'heart', limit: 3 });

    expect(hit?.url).toBe('https://my.clinic.example/heart');
    expect(hit?.title).toBe('Blood flow');
    expect(hit?.snippet).toBe('A series');
  });

  it('honours the limit', async () => {
    vi.stubGlobal('fetch', async () => new Response(resultPage(
      [1, 2, 3, 4, 5].map((n) => ({ href: wrapped(`https://e.example/${n}`), title: `r${n}`, snippet: '' })),
    ), { status: 200 }));

    expect(await search().search({ query: 'x', limit: 2 })).toHaveLength(2);
  });

  /** A markup change must degrade to "found nothing", not to a broken job. */
  it('returns nothing when the page stops looking like results', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html><body>redesigned</body></html>', { status: 200 }));

    expect(await search().search({ query: 'x', limit: 3 })).toEqual([]);
  });

  it('skips a result whose href is not a web page', async () => {
    vi.stubGlobal('fetch', async () => new Response(resultPage([
      { href: wrapped('javascript:alert(1)'), title: 'bad', snippet: '' },
      { href: wrapped('https://good.example/'), title: 'good', snippet: '' },
    ]), { status: 200 }));

    const hits = await search().search({ query: 'x', limit: 3 });
    expect(hits.map((h) => h.url)).toEqual(['https://good.example/']);
  });
});

/**
 * Scraping general image results would be keyless too, and unusable: an
 * arbitrary image on an arbitrary page has no licence anyone can state, and a
 * board that cannot be credited cannot be used.
 */
describe('OpenverseImageSource', () => {
  const source = () => new OpenverseImageSource({
    requestTimeoutMs: 5000, userAgent: UA, baseUrl: 'https://ov.example',
  });

  const png = () => sharp({
    create: { width: 400, height: 300, channels: 3, background: '#cccccc' },
  }).png().toBuffer();

  it('credits the creator and states the licence', async () => {
    const bytes = await png();
    vi.stubGlobal('fetch', async (url: URL | string) => {
      if (String(url).includes('/v1/images/')) {
        return new Response(JSON.stringify({
          results: [{
            title: 'Heart anatomy',
            url: 'https://cdn.example/heart.jpg',
            creator: 'A Photographer',
            license: 'by-sa',
            license_version: '4.0',
            foreign_landing_url: 'https://flickr.example/photo/1',
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(bytes, { status: 200 });
    });

    const image = await source().find({ query: 'heart', kind: 'diagram' });

    expect(image?.source).toBe('web_search');
    expect(image?.attribution).toMatchObject({
      author: 'A Photographer', sourceName: 'Openverse', licence: 'CC BY-SA 4.0',
    });
    expect(image?.attribution.sourceUrl).toBe('https://flickr.example/photo/1');
  });

  it('asks only for openly licensed work', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: URL | string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    await source().find({ query: 'heart', kind: 'diagram' });
    expect(seen[0]).toContain('license_type=all-cc');
  });

  /** A collection with no named creator still has a licence to honour. */
  it('credits an unnamed creator rather than nobody', async () => {
    const bytes = await png();
    vi.stubGlobal('fetch', async (url: URL | string) =>
      String(url).includes('/v1/images/')
        ? new Response(JSON.stringify({
            results: [{ url: 'https://cdn.example/x.jpg', license: 'cc0' }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(bytes, { status: 200 }));

    const image = await source().find({ query: 'heart', kind: 'photo' });
    expect(image?.attribution.author).toBe('Unknown creator');
    expect(image?.attribution.licence).toBe('CC0');
  });

  it('tries the next result when one cannot be fetched', async () => {
    const bytes = await png();
    vi.stubGlobal('fetch', async (url: URL | string) => {
      const href = String(url);
      if (href.includes('/v1/images/')) {
        return new Response(JSON.stringify({
          results: [
            { url: 'https://cdn.example/gone.jpg', creator: 'A', license: 'by' },
            { url: 'https://cdn.example/good.jpg', creator: 'B', license: 'by' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('gone')) return new Response('nope', { status: 404 });
      return new Response(bytes, { status: 200 });
    });

    const image = await source().find({ query: 'heart', kind: 'photo' });
    expect(image?.attribution.author).toBe('B');
  });
});
