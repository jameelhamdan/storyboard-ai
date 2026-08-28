/**
 * LLM-authored HTML and CSS is untrusted input about to execute in a browser.
 *
 * The storyboard author now writes its own layout, colour and SVG rather than
 * choosing from a fixed set of components, so this can no longer be "allow the
 * twelve documented shapes". It is instead a narrow allowlist of *structural and
 * presentational* markup, with every mechanism that can execute code or reach
 * the network removed outright.
 *
 * This is one of two defences, not the only one. `BrowserPool` additionally
 * aborts every request whose scheme is not `data:`, so a URL that slips past the
 * checks here still cannot reach anything. Neither layer is trusted alone.
 */

/**
 * Structure and text. Nothing here can load a resource or run code.
 *
 * SVG is deliberately absent. Every diagram shape a lesson needs — boxes,
 * connectors, arrows, rings, bars, grids — is expressible with flex, grid,
 * borders and border-radius, and HTML text wraps and reflows where SVG text
 * silently clips. Dropping it removed roughly forty tags and attributes from
 * this allowlist along with a whole class of layout failure.
 */
const ALLOWED_TAGS = new Set([
  'section', 'article', 'header', 'footer', 'aside', 'figure', 'figcaption',
  'div', 'span', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'b', 'i', 'small', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
  // A single scoped stylesheet per scene.
  'style',

  /**
   * SVG's drawing surface.
   *
   * A `<path>` with a `stroke-dasharray` is the only way to make a line draw
   * itself along its real geometry — an arrow that curves, an underline that
   * sweeps, a circle closing around a word. The HTML approximation is a
   * rectangle stretched with `scaleX`, which reads as a growing bar.
   *
   * `<text>` is deliberately *not* here: SVG text does not wrap or reflow, so
   * it clips silently at the edge of a shape. Labels stay in HTML, where the
   * layout engine can break them. That is the reflow guarantee the earlier
   * blanket ban was protecting; the ban was simply wider than the reason.
   */
  /**
   * A found photograph or published diagram, and only ever as a `data:` URI.
   *
   * `<img>` was banned outright while every board was drawn, and the ban was
   * doing two jobs: keeping scenes self-contained, and keeping the network out
   * of the renderer. The first is what actually mattered — an inlined image is
   * as self-contained as a `<path>` — so the rule is now about the *scheme*
   * rather than the tag, enforced below. A remote URL is still rejected, and
   * `BrowserPool` still aborts anything that reaches the wire.
   */
  'img',

  'svg', 'g', 'path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect',
  'defs', 'marker', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'title', 'desc',
]);

/**
 * Elements removed wholesale, with their content.
 *
 * Two groups survive the move to allowing SVG:
 *
 * `use`, `image` and `foreignObject` are each a way for SVG to pull in
 * something external or re-enter HTML parsing — the SVG equivalents of an
 * `<iframe>`.
 *
 * `animate`, `animateTransform`, `animateMotion` and `set` are SMIL, which
 * advances against the wall clock exactly as a CSS animation does. Every frame
 * in this renderer is produced by seeking to a millisecond, so a SMIL element
 * would make two renders of the same frame differ and break the resume
 * guarantee. Motion is driven by `--p`, never by a timer.
 */
const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'template',
  'form', 'input', 'button', 'select', 'textarea', 'label',
  'picture', 'source', 'video', 'audio', 'track',
  'use', 'image', 'foreignobject',
  'animate', 'animatetransform', 'animatemotion', 'set',
  // SVG text does not wrap; a label that outgrows its shape clips instead of
  // reflowing. Text belongs in HTML, which is why this one stays rejected.
  'text', 'tspan', 'textpath',
];

const ALLOWED_CLASS_PREFIX = 'sc-';

/**
 * Structural attributes only — everything visual belongs in the style block.
 *
 * Every `data-*` attribute is allowed generically rather than enumerated: the
 * renderer reads `data-reveal-at` and `data-draw`, and a scene inventing its own
 * is inert. Nothing here can name a resource: `href`, `src` and `xlink:href` are
 * absent and separately rejected.
 */
const ALLOWED_ATTRIBUTES = new Set([
  'class', 'id', 'lang', 'role', 'colspan', 'rowspan', 'aria-label', 'aria-hidden',

  /**
   * For `<img>`. `src` is allowed as a *name* here and constrained to
   * `data:image/` by the resource rules below — the two checks are separate
   * because an attribute allowlist cannot express "only with this value".
   */
  'src', 'alt',

  /**
   * SVG geometry. Shape only — every one of these describes *where* something
   * is, never what it looks like or where it loads from. Presentation still
   * belongs in the style block, which is what keeps scenes on the palette.
   */
  'viewbox', 'preserveaspectratio', 'xmlns', 'd', 'points', 'transform',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'offset', 'fill-rule', 'clip-path', 'marker-end', 'marker-start',
  'refx', 'refy', 'orient', 'markerwidth', 'markerheight', 'gradientunits',
  'pathlength',
]);

/**
 * CSS constructs rejected inside a `<style>` block.
 *
 * The first three are network reach. The last two are determinism: an animation
 * or transition advances against the wall clock, so the same frame would render
 * differently depending on how long layout took — and the chaos/resume path
 * depends on a re-rendered segment matching the one it replaces.
 */
const FORBIDDEN_CSS = [
  { pattern: /@import/i, reason: '@import in <style>' },
  { pattern: /url\s*\(/i, reason: 'url() in <style>' },
  { pattern: /@font-face/i, reason: '@font-face in <style> — the renderer inlines the face' },
  { pattern: /\banimation(-name|-duration)?\s*:/i, reason: 'CSS animation is non-deterministic across renders' },
  { pattern: /\btransition\s*:/i, reason: 'CSS transition is non-deterministic across renders' },
  { pattern: /expression\s*\(/i, reason: 'CSS expression()' },
  { pattern: /behaviou?r\s*:/i, reason: 'CSS behavior' },
  // The prompt asks for palette custom properties and a real run wrote raw
  // colours anyway, putting reds on a blue-and-ochre board. Asking is not
  // enforcement: a rejected scene is regenerated with the reason attached,
  // where an off-palette one ships looking like a different video.
  { pattern: /#[0-9a-fA-F]{3,8}\b/, reason: 'raw hex colour in <style> — use var(--ink-*)' },
  { pattern: /\b(?:rgba?|hsla?)\s*\(/i, reason: 'raw colour function in <style> — use var(--ink-*)' },
  {
    pattern: /(?:color|background|border|fill|stroke|outline)[a-z-]*\s*:[^;{}]*\b(?:red|blue|green|yellow|orange|purple|pink|brown|grey|gray|black|white|cyan|magenta|teal|navy|olive|maroon|lime|aqua|silver|gold|crimson|indigo|violet)\b/i,
    reason: 'named colour in <style> — use var(--ink-*)',
  },
];

export interface SanitisationResult {
  readonly html: string;
  readonly violations: readonly string[];
}

export class HtmlSanitizer {
  public sanitize(html: string): SanitisationResult {
    const violations: string[] = [];
    let output = html;

    // 1. Remove anything that can execute or load, content and all.
    for (const tag of FORBIDDEN_TAGS) {
      const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?(?:</${tag}>|/>)`, 'gi');
      const selfClosing = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
      if (pattern.test(output) || selfClosing.test(output)) {
        violations.push(`disallowed <${tag}> element`);
        output = output.replace(pattern, '').replace(selfClosing, '');
      }
    }

    // 2. Event handlers and script URLs.
    if (/\son\w+\s*=/i.test(output)) {
      violations.push('inline event handler attribute');
      output = output.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    }
    for (const scheme of [/javascript:/gi, /vbscript:/gi]) {
      if (scheme.test(output)) {
        violations.push('script URL scheme');
        output = output.replace(scheme, '');
      }
    }

    // 3. Anything naming a resource. The scene must be self-contained; the
    //    browser blocks these too, but a rejected scene is better than a
    //    silently missing image.
    //
    //    `src` is the one exception, and only for an inlined image: a
    //    `data:image/` URI names no resource, reaches no network and travels
    //    with the scene. Anything else in a `src` — including `data:` of another
    //    type — is rejected exactly as before. The negative lookahead is what
    //    makes this a rule about the value rather than about the attribute.
    for (const [pattern, reason] of [
      [/\s(?:xlink:)?href\s*=/gi, 'href attribute'],
      [/\ssrc\s*=\s*(?!["']data:image\/)/gi, 'src attribute naming something other than an inlined image'],
      [/https?:\/\//gi, 'absolute URL'],
    ] as const) {
      if (pattern.test(output)) {
        violations.push(`${reason} — scenes must reference nothing external`);
        output = output.replace(pattern, ' ');
      }
    }

    // 4. Inline styles stay banned. A single scoped <style> block is far easier
    //    to audit than styles scattered across fifty elements, and the model can
    //    express anything through classes that it could express inline.
    if (/\sstyle\s*=/i.test(output)) {
      violations.push('inline style attribute — use a single <style> block');
      output = output.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    }

    // 5. Validate <style> content, then set it aside so its CSS is not scanned
    //    as if it were markup — `a { b: c }` would otherwise read as attributes.
    const styleBlocks: string[] = [];
    const withoutStyles = output.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
      styleBlocks.push(css);
      return '';
    });

    for (const css of styleBlocks) {
      for (const { pattern, reason } of FORBIDDEN_CSS) {
        if (pattern.test(css)) violations.push(reason);
      }
    }

    // 6. Tag allowlist.
    for (const match of withoutStyles.matchAll(/<\s*\/?\s*([a-z0-9-]+)/gi)) {
      const tag = match[1]!.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) violations.push(`disallowed element <${tag}>`);
    }

    // 7. Classes stay namespaced. The model may invent any class it likes as
    //    long as it is prefixed, which keeps scene styles from colliding with
    //    the base stylesheet.
    for (const match of withoutStyles.matchAll(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      for (const className of (match[1] ?? match[2] ?? '').split(/\s+/).filter(Boolean)) {
        if (!className.startsWith(ALLOWED_CLASS_PREFIX)) {
          violations.push(`class '${className}' must start with '${ALLOWED_CLASS_PREFIX}'`);
        }
      }
    }

    // 8. Attribute allowlist, `data-*` allowed generically.
    for (const match of withoutStyles.matchAll(/\s([a-z][a-z0-9:-]*)\s*=/gi)) {
      const attribute = match[1]!.toLowerCase();
      if (attribute.startsWith('data-')) continue;
      if (!ALLOWED_ATTRIBUTES.has(attribute)) {
        violations.push(`disallowed attribute '${attribute}'`);
      }
    }

    return { html: output, violations: [...new Set(violations)] };
  }
}
