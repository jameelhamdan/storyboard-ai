# Whiteboard Style

A normal whiteboard: white board, dark marker, clean handwriting. Not textured paper, not a
chalkboard, no skeuomorphic gloss. The look is defined entirely by CSS custom properties so it can be
retuned without touching a component.

Everything below is a **default**. Change the token, not the component — every one of these reaches
the renderer as a CSS custom property, and `test/unit/theme.test.ts` fails if one stops doing so.
(Seven of them silently did not, for a while: they were schema-validated and then dropped before
they reached the page, so this document promised control the renderer never had.)

The colours specifically are a *fallback*: when a real model runs, the `visualPlan` stage picks a
palette suited to the subject before any scene is written, and it overrides these. These values are
what a stub run uses, and what a video falls back to if planning fails.

---

## Theme tokens

`config/theme.yaml` → emitted as `:root` custom properties at render time.

```yaml
board:
  background:        "#FFFFFF"   # the board
  vignette:          "none"      # "subtle" adds a faint edge shadow
  padding_rem:       4

ink:
  primary:           "#1F2933"   # main marker — near-black, not pure black
  secondary:         "#52606D"   # supporting text
  accent:            "#2B6CB0"   # primary emphasis, arrowheads, the active element
  accents:                       # 2–4, primary first; distinguish parallel things
    - "#2B6CB0"
    - "#B7791F"
    - "#2F855A"
  muted:             "#9AA5B1"   # axes, gridlines, de-emphasised

stroke:
  width_px:          3           # marker thickness
  linecap:           "round"
  jitter:            0.6         # 0 = ruler-straight, 1 = visibly hand-drawn
  corner_radius_px:  6

type:
  family:            "'Kalam', 'Segoe Print', cursive"
  fallback:          "system-ui, sans-serif"
  title_rem:         3.2
  body_rem:          2.0
  label_rem":        1.6
  min_rem:           1.4         # legibility floor — Stage A fails below this
  line_height:       1.35
  letter_spacing_em: 0.01

motion:
  draw_ms_per_100px: 180         # line-drawing speed
  reveal_ms:         260         # fade/slide-in duration for text
  ease:              "cubic-bezier(0.4, 0.0, 0.2, 1)"
  stagger_ms:        90          # gap between sibling reveals with the same anchor
```

---

## The four rules the components follow

**1. A small, agreed palette.** `ink.accents` holds two to four colours, primary first. The first
marks emphasis, arrowheads and the active element; the rest distinguish *parallel* things — the arms
of a comparison, the bands of a stack, the stages of a process. Everything else stays
`ink.primary` or `ink.secondary`.

> **Reversed decision.** This rule used to read "one accent colour only", on the grounds that
> multi-colour whiteboards read as cluttered. That held while the renderer drew title-and-bullets and
> nothing was parallel. Once scenes author real diagrams, a single accent forces every distinction
> into greyscale, and at 720p two greys are far harder to tell apart than two hues. The clutter risk
> is real, so the palette stays small and is chosen once per video by the `visualPlan` stage rather
> than per scene.
>
> Two accents that differ only in saturation will look identical after encoding. Differ in hue.

**2. Elements draw, text reveals.** Lines, boxes, arrows, and axes animate their stroke —
`stroke-dashoffset` from full length to zero, at `motion.draw_ms_per_100px`. Text does not draw
letter-by-letter (illegible at 24fps and slow to render); it fades and rises over `motion.reveal_ms`.

**3. Hand-drawn means slightly imperfect, not messy.** `stroke.jitter` applies a small per-path
displacement so lines aren't ruler-straight. Default `0.6` is visible but calm. Above `0.8` it starts
reading as sloppy rather than human.

**4. Nothing moves after it arrives.** Elements reveal and then hold still. No drifting, pulsing, or
parallax — motion after arrival pulls attention off the narration.

---

## Legibility floor

Non-negotiable, because the output is 720p and viewers may be on a phone:

- Body text never below `type.min_rem` (Stage A fails the scene).
- Contrast at least 4.5:1 against `board.background` (Stage A checks this).
- Maximum 5 elements visible at once — beyond that the scene should have been split.
- Labels 1–4 words. Longer belongs in narration, not on the board.

---

## Fonts

Default `Kalam` — an open-licence handwriting face that stays readable at small sizes, which most
handwriting fonts do not. **Self-host it**: the renderer runs under a CSP with no external requests,
and a missing font silently falls back and changes every layout.

Swapping it is a token change, but check the new face at `type.min_rem` on a 720p frame before
committing — legibility at size is the only criterion that matters here.

---

## Two presets

`theme.yaml` ships both; `standard` is the default.

| Preset | Difference |
|---|---|
| `standard` | The tokens above |
| `crisp` | `stroke.jitter: 0.2`, `type.family` set to a geometric sans. Cleaner, more corporate — for material where handwriting reads as unserious (finance, medicine, law) |

---

## Deliberately not included

- **Paper or canvas texture** — costs render time on every frame and muddies text at 720p.
- **A drawing hand** — the reference videos use one, but it occludes content, is expensive to
  animate convincingly, and adds nothing the stroke animation doesn't already convey.
- **Drop shadows and gradients** — they read as digital, not as marker on a board.
- **An unconstrained palette** — the accent set is capped at four and chosen once per video, not per
  scene. See rule 1 for why the "one accent" rule was relaxed rather than removed.

Each of these is a deliberate omission rather than an oversight. If Saman wants the drawing hand at
M1 review, it is additive work on top of a working renderer, not a change to the model.
