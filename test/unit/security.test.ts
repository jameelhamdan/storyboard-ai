import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from '@infrastructure/http/SafeHttpClient.js';
import { ArchiveGuard } from '@infrastructure/extraction/ArchiveGuard.js';
import { HtmlSanitizer } from '@infrastructure/render/HtmlSanitizer.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';

/**
 * These matter more than usual: the caller supplies arbitrary URLs and files, the
 * API has no auth, and the workers sit on an internal network next to Redis.
 */
describe('SSRF address guard', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.1.2.3')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks the cloud metadata endpoint', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks every RFC1918 range', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('allows the public addresses adjacent to RFC1918', () => {
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('blocks CGNAT, multicast and 0.0.0.0', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 link-local and unique-local', () => {
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
  });

  it('blocks IPv4-mapped loopback rather than waving it through as IPv6', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('refuses anything that is not an IP at all', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('ArchiveGuard — DOCX and PPTX are zip containers', () => {
  const guard = new ArchiveGuard({
    maxEntries: 100, maxUncompressedBytes: 1_000_000, maxCompressionRatio: 50,
  });
  const entry = (name: string, compressed: number, uncompressed: number) =>
    ({ name, compressedSize: compressed, uncompressedSize: uncompressed });

  it('accepts an ordinary archive', () => {
    expect(() => guard.assertSafe('a.pptx', [entry('ppt/slides/slide1.xml', 1000, 4000)])).not.toThrow();
  });

  it('rejects too many entries', () => {
    const many = Array.from({ length: 101 }, (_, i) => entry(`f${i}`, 10, 20));
    expect(() => guard.assertSafe('a.pptx', many)).toThrow(UnsupportedFormatError);
  });

  it('rejects a decompression bomb by total size', () => {
    expect(() => guard.assertSafe('a.pptx', [entry('big', 1000, 5_000_000)])).toThrow(/uncompressed size/);
  });

  it('rejects a bomb that passes size but not ratio', () => {
    expect(() => guard.assertSafe('a.pptx', [entry('b', 100, 900_000)])).toThrow(/compression ratio/);
  });

  it('rejects zip-slip paths', () => {
    expect(() => guard.assertSafe('a.pptx', [entry('../../etc/passwd', 10, 20)])).toThrow(/unsafe path/);
    expect(() => guard.assertSafe('a.pptx', [entry('/etc/passwd', 10, 20)])).toThrow(/unsafe path/);
  });
});

describe('HtmlSanitizer — LLM output is untrusted input for a browser', () => {
  const sanitizer = new HtmlSanitizer();
  const clean = (html: string) => sanitizer.sanitize(html).violations;

  describe('what a scene is now allowed to author', () => {
    it('accepts a scene with its own scoped stylesheet and a flow built from divs', () => {
      // The shape the storyboard prompt asks for: semantic classes, one <style>
      // block, and diagrams built from styled elements rather than SVG.
      const html = `<section class="sc-scene" data-scene="1">
        <style>
          .sc-flow { display: flex; gap: 2rem; align-items: center; }
          .sc-node { border: 3px solid var(--ink-accent-1); padding: 1rem; }
        </style>
        <h2 class="sc-title">Cellular respiration</h2>
        <div class="sc-flow">
          <div class="sc-node" data-reveal-at="0">Glycolysis</div>
          <div class="sc-connector" data-draw="normal"></div>
          <div class="sc-node" data-reveal-at="400">Pyruvate</div>
        </div>
      </section>`;
      expect(clean(html)).toEqual([]);
    });

    it('accepts tables and figures', () => {
      const html = `<figure class="sc-figure">
        <table class="sc-matrix"><tr><th colspan="2">Yield</th></tr><tr><td>36</td><td>2</td></tr></table>
        <figcaption class="sc-caption">ATP yield</figcaption>
      </figure>`;
      expect(clean(html)).toEqual([]);
    });

    /**
     * SVG is allowed for *shape*, because a stroked path is the only way a line
     * can draw itself along its real geometry. It stays rejected for *text*,
     * because SVG text does not wrap — a label that outgrows its shape clips
     * silently where HTML would reflow it. The old blanket ban protected the
     * reflow guarantee, but was wider than the reason for it.
     */
    it('accepts SVG shapes, so a stroke can draw itself along a real path', () => {
      const html = `<svg class="sc-diagram" viewBox="0 0 100 40">
        <path class="sc-arrow" id="a1" d="M2 20 H92" pathLength="1"/>
        <circle class="sc-dot" cx="95" cy="20" r="4"/>
      </svg>`;
      expect(clean(html)).toEqual([]);
    });

    it('still rejects SVG text, which clips instead of reflowing', () => {
      for (const tag of ['text', 'tspan', 'textPath']) {
        expect(clean(`<svg><${tag}>label</${tag}></svg>`).join().toLowerCase())
          .toMatch(tag.toLowerCase());
      }
    });

    it('accepts SVG geometry attributes but not presentation', () => {
      // Shape says where; the palette still comes from the style block.
      expect(clean('<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8"/></svg>')).toEqual([]);
      expect(clean('<svg><rect fill="red"/></svg>').join()).toMatch(/disallowed attribute 'fill'/);
    });

    it('accepts any invented class, so long as it is namespaced', () => {
      // Free-form means the model names its own things; the prefix only stops
      // them colliding with the base stylesheet.
      expect(clean('<div class="sc-split-panel sc-emphasis-ring">x</div>')).toEqual([]);
    });

    it('accepts arbitrary data-* attributes', () => {
      expect(clean('<div class="sc-node" data-reveal-at="120" data-anything="x">y</div>')).toEqual([]);
    });
  });

  describe('code execution', () => {
    it('strips scripts and reports them', () => {
      const result = sanitizer.sanitize('<section class="sc-scene"><script>fetch("/x")</script></section>');
      expect(result.html).not.toContain('script');
      expect(result.violations.join()).toMatch(/script/);
    });

    it('strips inline event handlers', () => {
      const result = sanitizer.sanitize('<div class="sc-item" onclick="steal()">x</div>');
      expect(result.html).not.toMatch(/onclick/i);
      expect(result.violations.join()).toMatch(/event handler/);
    });

    it('strips javascript: and vbscript: schemes', () => {
      expect(clean('<div class="sc-item">javascript:alert(1)</div>').join()).toMatch(/script URL/);
      expect(clean('<div class="sc-item">vbscript:x</div>').join()).toMatch(/script URL/);
    });

    it('rejects SMIL animation elements, which run on their own clock', () => {
      // Allowing SVG shapes does not allow SVG *timing*: every frame here is
      // produced by seeking to a millisecond, so anything self-animating would
      // make two renders of the same frame differ.
      for (const tag of ['animate', 'animateTransform', 'animateMotion', 'set']) {
        expect(clean(`<svg><${tag} attributeName="x" dur="1s"/></svg>`).join().toLowerCase())
          .toMatch(tag.toLowerCase());
      }
    });
  });

  describe('network reach', () => {
    it('rejects anything naming an external resource', () => {
      for (const html of [
        '<img src="http://evil/x.png">',
        '<div class="sc-item"><a href="http://evil">x</a></div>',
        '<use xlink:href="http://evil#x"/>',
        '<div class="sc-item">see https://evil.example</div>',
      ]) {
        expect(clean(html).length).toBeGreaterThan(0);
      }
    });

    it('rejects url() and @import inside a style block', () => {
      expect(clean('<style>.sc-a{background:url(http://evil/x.png)}</style>').join()).toMatch(/url\(/);
      expect(clean('<style>@import "http://evil/x.css";</style>').join()).toMatch(/@import/);
    });

    it('rejects @font-face — the renderer inlines the face itself', () => {
      expect(clean('<style>@font-face{font-family:x}</style>').join()).toMatch(/font-face/);
    });

    it('strips elements that load resources', () => {
      // `use`, `image` and `foreignObject` survive the move to allowing SVG:
      // each is a way for SVG to pull in something external or re-enter HTML
      // parsing — the SVG equivalents of an <iframe>.
      for (const tag of ['iframe', 'object', 'embed', 'link', 'video', 'audio',
                         'foreignObject', 'use', 'image']) {
        expect(clean(`<${tag}></${tag}>`).length, `<${tag}> should be rejected`).toBeGreaterThan(0);
      }
    });
  });

  describe('determinism', () => {
    // Both advance against the wall clock, so the same frame would render
    // differently depending on how long layout took — and the chaos/resume path
    // depends on a re-rendered segment matching the one it replaces.
    it('rejects CSS animation', () => {
      expect(clean('<style>.sc-a{animation:fade 1s}</style>').join()).toMatch(/animation/);
      expect(clean('<style>.sc-a{animation-name:fade}</style>').join()).toMatch(/animation/);
    });

    it('rejects CSS transition', () => {
      expect(clean('<style>.sc-a{transition:opacity .3s}</style>').join()).toMatch(/transition/);
    });

    it('allows the custom property the seek driver writes', () => {
      // Motion is legal — it just has to be driven by --p rather than a timer.
      expect(clean('<style>.sc-a{opacity:var(--p)}</style>')).toEqual([]);
    });
  });

  describe('markup hygiene', () => {
    it('rejects an unnamespaced class', () => {
      expect(clean('<div class="totally-custom">x</div>').join()).toMatch(/must start with/);
    });

    it('rejects inline style attributes in favour of one style block', () => {
      const result = sanitizer.sanitize('<div class="sc-item" style="color:var(--ink-primary)">x</div>');
      expect(result.html).not.toMatch(/style=/);
      expect(result.violations.join()).toMatch(/single <style> block/);
    });

    it('does not mistake CSS declarations for attributes', () => {
      // The style block is set aside before attribute scanning; otherwise
      // `color: red` reads as an attribute named `color`.
      expect(clean('<style>.sc-a{color:var(--ink-primary);padding:1rem}</style>')).toEqual([]);
    });

    it('rejects form controls', () => {
      for (const tag of ['form', 'input', 'button', 'textarea']) {
        expect(clean(`<${tag}></${tag}>`).length).toBeGreaterThan(0);
      }
    });
  });
});

/**
 * The palette is chosen once per video and handed to the scene as custom
 * properties. A scene writing its own colours produces a board that belongs to a
 * different video — and a real run did exactly that, putting reds on a
 * blue-and-ochre palette. The prompt asks; this enforces.
 */
describe('palette discipline', () => {
  const sanitizer = new HtmlSanitizer();
  const clean = (html: string) => sanitizer.sanitize(html).violations;

  it('rejects raw hex colours', () => {
    expect(clean('<style>.sc-a{color:#C53030}</style>').join()).toMatch(/raw hex/);
    expect(clean('<style>.sc-a{background:#fff}</style>').join()).toMatch(/raw hex/);
  });

  it('rejects rgb() and hsl()', () => {
    expect(clean('<style>.sc-a{color:rgb(200,0,0)}</style>').join()).toMatch(/colour function/);
    expect(clean('<style>.sc-a{color:hsl(0,100%,50%)}</style>').join()).toMatch(/colour function/);
  });

  it('rejects named colours on colour properties', () => {
    expect(clean('<style>.sc-a{color:red}</style>').join()).toMatch(/named colour/);
    expect(clean('<style>.sc-a{border:3px solid crimson}</style>').join()).toMatch(/named colour/);
  });

  it('accepts the palette custom properties', () => {
    expect(clean(`<style>
      .sc-a { color: var(--ink-primary); border: 3px solid var(--ink-accent-2); }
      .sc-b { background: var(--board-bg); }
    </style>`)).toEqual([]);
  });

  it('does not mistake a non-colour word for a colour', () => {
    // 'green' inside a label is content, not a style declaration.
    expect(clean('<style>.sc-a{padding:1rem}</style><p class="sc-a">green plants</p>')).toEqual([]);
  });
});
