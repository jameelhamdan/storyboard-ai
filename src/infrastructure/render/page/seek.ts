/**
 * The in-page time driver, as source text.
 *
 * This is a string rather than a module because it runs inside the browser, not
 * in Node — it is inlined into the document the renderer loads.
 *
 * **Why not CSS animations.** A CSS animation or transition advances against the
 * wall clock. Two renders of the same frame would then differ by however long
 * the page took to lay out, which breaks the chaos/resume guarantee that a
 * segment re-rendered on another worker matches the one it replaces. So there is
 * no timer here and nothing is asynchronous: `__seekTo(ms)` computes each
 * element's progress from `ms` alone and writes it to a custom property. The
 * same millisecond always produces the same pixels.
 *
 * Elements carry `data-reveal-at` (milliseconds, absolute within the scene).
 * Progress `--p` runs 0 → 1 across the element's own duration, and the
 * stylesheet decides what that means — a rise, a scale, a wipe, or a stroke
 * drawing itself along its path.
 */
export const SEEK_SCRIPT = String.raw`
(function () {
  var root = document.documentElement;
  var revealMs = Number(root.dataset.revealMs || '260');
  var staggerMs = Number(root.dataset.staggerMs || '0');

  /**
   * Per-element duration.
   *
   * The storyboard model already chooses a draw speed per anchor — it travels
   * as data-draw-speed. Everything used to play at one global revealMs, so the
   * model's choice was collected, validated, checkpointed, and then ignored.
   */
  var SPEED = { fast: 0.6, normal: 1, slow: 1.8 };

  function clamp01(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  /**
   * Easing, from the theme's cubic-bezier control points.
   *
   * Solved by bisection rather than a closed form: a bezier's x is not
   * invertible analytically, and 18 iterations is exact to well under a pixel
   * while staying perfectly deterministic — the same t always yields the same
   * value, on any machine.
   */
  function bezier(p1x, p1y, p2x, p2y) {
    function curve(a, b, t) {
      var inv = 1 - t;
      return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
    }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var low = 0, high = 1, mid = x;
      for (var i = 0; i < 18; i++) {
        mid = (low + high) / 2;
        if (curve(p1x, p2x, mid) < x) low = mid; else high = mid;
      }
      return curve(p1y, p2y, mid);
    };
  }

  function parseEase(value) {
    var match = /cubic-bezier\(([^)]+)\)/.exec(value || '');
    if (match) {
      var parts = match[1].split(',').map(Number);
      if (parts.length === 4 && parts.every(function (n) { return isFinite(n); })) {
        return bezier(parts[0], parts[1], parts[2], parts[3]);
      }
    }
    // Ease-out cubic, the previous behaviour, when the theme says nothing usable.
    return function (t) { var inv = 1 - t; return 1 - inv * inv * inv; };
  }

  var themeEase = parseEase(
    getComputedStyle(root).getPropertyValue('--motion-ease').trim(),
  );

  /**
   * A slight overshoot for elements that scale in, so emphasis reads as
   * deliberate rather than as a fade with extra steps. Everything else uses the
   * theme curve.
   */
  function overshoot(t) {
    if (t >= 1) return 1;
    var c = 1.70158, s = c + 1, inv = t - 1;
    return 1 + s * inv * inv * inv + c * inv * inv;
  }

  window.__seekTo = function (ms) {
    var nodes = document.querySelectorAll('[data-reveal-at]');

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var at = Number(node.getAttribute('data-reveal-at'));

      // Siblings that arrive together are offset so a list resolves in sequence
      // rather than appearing as one block. The index is stamped in Node, so it
      // is stable across renders.
      var order = Number(node.getAttribute('data-stagger-index') || '0');
      var start = at + order * staggerMs;

      var speed = SPEED[node.getAttribute('data-draw-speed')] || 1;
      var duration = revealMs * speed;

      var raw = duration <= 0 ? 1 : (ms - start) / duration;
      var enter = node.getAttribute('data-enter');
      var p = (enter === 'scale' ? overshoot : themeEase)(clamp01(raw));

      node.style.setProperty('--p', String(p));

      // A discrete flag as well as the continuous value: some rules want "has it
      // started at all" without interpolating.
      if (ms >= start) {
        node.setAttribute('data-revealed', '1');
      } else {
        node.removeAttribute('data-revealed');
      }
    }

    __fitToFrame();

    // Signals to the renderer that a seek completed, so a screenshot taken after
    // this reflects the requested time and not the previous one.
    root.setAttribute('data-seeked', String(ms));
    return true;
  };

  /**
   * Scale a scene that outgrew the frame, rather than letting it clip.
   *
   * The board is 'overflow: hidden', so an overlong scene would lose its bottom
   * silently. Scaling is deterministic — it depends on layout, not on time — and
   * costs no extra renders.
   *
   * **Measuring once is safe, and the reason is worth stating.** The result is
   * cached, and the two callers reach it at different times: the previewer seeks
   * straight past the end, while the renderer reuses one page per segment and
   * seeks to frame 0 first. That would matter if a reveal changed layout — but
   * every reveal effect here is a transform, an opacity or a clip-path, and none
   * of those participate in layout, so the measured overflow mid-reveal equals
   * the measured overflow settled. Add a reveal that animates margin, width or
   * font-size and this stops being true — which is what the fit-agreement test
   * in test/integration/diagram-layout.test.ts guards.
   */
  var fitted = false;
  function __fitToFrame() {
    if (fitted) return;
    fitted = true;

    var board = document.querySelector('.sc-board');
    var scene = document.querySelector('.sc-scene');
    if (!board || !scene) return;

    var worst = Math.max(
      scene.scrollHeight / board.clientHeight,
      scene.scrollWidth / board.clientWidth,
    );
    if (worst <= 1.001) return;

    // Floor at 0.6: below that the scene is not overfull, it is wrong, and
    // shrinking it further trades a clipped board for an illegible one.
    var scale = Math.max(0.6, 1 / worst);
    scene.style.setProperty('transform', 'scale(' + scale.toFixed(4) + ')');
    scene.style.setProperty('transform-origin', 'top center');
    root.setAttribute('data-fitted', scale.toFixed(4));
  }

  /** The cross-fade between scenes; 0 unless the renderer sets it. */
  window.__setTransition = function (progress) {
    root.style.setProperty('--scene-opacity', String(clamp01(progress)));
    return true;
  };
})();
`;
