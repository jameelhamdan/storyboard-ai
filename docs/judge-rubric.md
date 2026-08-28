# Judge Rubric

Replaces the brief's "assessed by Saman" with something reproducible. Two stages, cheapest first.
Only Stage B uses a model; Stage A is deterministic and free.

---

## Stage A — deterministic (no model)

Two kinds of check, both free. The markup checks read the HTML. The geometry checks read the
*laid-out page* — they run inside the same `page.evaluate` that takes the judge's screenshot, so
they cost one extra evaluation and no extra page load. See
`src/infrastructure/render/page/measure.ts`.

| # | Check | Fails when |
|---|---|---|
| A1 | Markup validity | Anything the sanitizer objects to, or not exactly one `sc-title` |
| A3 | Anchor resolution | More than one `data-on` phrase per scene fails to match the narration |
| A4 | Overflow | Any inked element lies outside the frame, or the board had to be scaled to fit |
| A5 | Legibility floor | Computed font size below `theme.type.min_rem` |
| A6 | Collision | Two inked elements' rendered boxes intersect by more than a pixel |
| A7 | Duration fit | Scene narration duration outside its allotted window |

> **A4, A5 and A6 came back.** They were deleted once, on the reasoning that geometry was better
> answered by a vision model looking at a screenshot than by reimplementing layout measurement. That
> was wrong, and a real run proved it: in `out/20260827-202226-battery` scene 0 shipped with its
> centre box covering the label beside it and **passed all five gates with a holistic score of 4**.
> A browser knows exactly where every box is; asking a model to notice is strictly worse and costs
> money. They are cheap now because the renderer owns layout, so there is a fixed set of inked
> elements to measure.
>
> **A2 (cardinality) stays deleted.** It counted items against a per-component range, which only
> meant something while the renderer had a hand-coded template expecting a particular number.
>
> **A8 (is it a diagram?) was deleted, and this is not a loosening.** It rejected a board that was a
> title over a bullet list. Boards are now built by `renderDiagram` from a validated `SceneDiagram`,
> whose shape vocabulary contains no `list` and no `none` — a board of text is not something the
> format can express. A check that cannot fail is worse than no check, because it reads as coverage.
> The guarantee is asserted instead in `test/unit/scene-diagram.test.ts`.

A scene failing any Stage A check is regenerated **without a model call being spent on judging it**.
That is most of why the judge stopped dominating the bill: a board with a collision in it is going to
be regenerated whatever a model thinks of its wording.

---

## Stage B — scene judge (vision, per scene attempt)

Runs on one screenshot of the finished scene, on the **quality tier**. Four binary gates decide pass
or regenerate; one holistic score is reported and never gates.

### Gating criteria

| # | Name | The question | Fails when |
|---|---|---|---|
| **G1** | Grounding | Is every visible word faithful to the cited source? | A label states something the source does not — a different claim, an invented figure, a term the material never introduces, or a compression that changes the meaning |
| **G2** | Fit | Does the picture express a relationship the narration **states**? | An edge claims a connection the source did not state. Proximity in the text is not a stated relationship |
| **G3** | Completeness | Is every key term the narration foregrounds actually on screen? | The narration names a concept as central and nothing on screen shows it |
| **G4** | Composition | Does the board read well as a picture? | No clear focal point, clutter that carries no meaning, or emphasis on the wrong element |

A scene passes only if **all four pass**. Each failing gate returns its own note, so the regeneration
prompt is told what to fix rather than asked to try again.

> **G1 was rewritten, and it is the most important change in this file.** It used to fail any label
> that was "true but not present" in the source. A board's labels are one to four words long, so they
> are necessarily shorter than the sentences they come from — paraphrase is not a defect, it is what
> a label *is*. That reading rejected an accurate board three times in a row and replaced it with a
> worse one. It now fails a label that states something the source does not, and explicitly does not
> fail one for being a shortened form.
>
> **G5 (consistency) was deleted.** It asked whether a scene sits with the one before it, and the
> judge was only ever sent one screenshot — its own — so the comparison had no input and the gate
> passed unconditionally while still costing image tokens on every call. The property is now
> structural: every board is laid out by the same templates from the same theme.
>
> **G4 changed meaning.** It was a legibility floor, which is now measured in Stage A. It is the
> composition question instead — the part of "does this look good" that is genuinely not mechanical.

### Holistic score — reported, never gates

> On a scale of 1–5, how close is this frame to a professional whiteboard explainer video?
> 1 = obviously machine-generated · 3 = acceptable but plain · 5 = indistinguishable from
> professionally produced.

Model numeric scores drift between runs, which would make a threshold on one flaky and arbitrary. It
has exactly one mechanical use: **breaking ties between attempts** when several failed the same
number of gates, in `JudgeStoryboardStage`. Otherwise it is reported in `QualityVerdict` and tracked
across iterations.

### Retry budget and what ships

A failing scene regenerates up to `judge.maxSceneRetries` times, with the failed gate ids and the
judge's own notes fed into the retry. A scene that failed three or more gates at once gets **one**
attempt rather than the full budget — it is not going to converge, and spending the same budget on a
near-miss and a wreck is how the judge became 80% of a run's wall clock.

**On exhaustion the best attempt ships** — fewest failed gates, ties broken by holistic score. This
replaces a fallback that discarded every attempt for a synthetic board built by slicing the narration
into word windows, which was never itself judged and produced labels like "cathode is lithium". Two
of five scenes in the battery run shipped that way, and the board they replaced was better than what
replaced it.

The synthetic board remains, for the one case it is actually for: a scene where **no** attempt
produced anything renderable. It is a `focus` diagram stating the scene's opening sentence. More than
`judge.maxFallbackScenes` of those fails the job with `GENERATION_FAILED`.

### Concurrency

Scenes are judged concurrently under `concurrency.judge`. They used to run serially, and the reason
was never the judging — it was a stage-level fallback counter that every scene read and wrote, which
would have made *which* scene tripped the limit depend on timing. The budget is checked once at the
end over the finished set, so the loop has no shared state left.

---

## Stage C — video judge

**Not implemented. The stage was removed and has not returned.**

The intent was to sample N frames from the rendered MP4 and score sync, pacing and coherence
end-to-end, reported but never gating. What was actually built called a quality-tier model with an
empty frame list and an empty cue list — and ran *before* the subtitles stage, so cues could not have
existed. It produced a score from the prompt text alone, at full price, and nothing downstream could
distinguish that from a real measurement.

A reported-only score that measures nothing is worse than no score: it occupies the place where a
real one would go.

Restoring it means three things, in this order:

1. Sample frames during `assemble`, when the MP4 and its duration are both in hand.
2. Run the stage *after* `subtitles`, so the cues it judges sync against exist.
3. Calibrate it the way Stage B should be calibrated below.

**Nothing in this pipeline judges the finished video, or judges animation over time.** Every
assessment is one static frame per scene attempt. Reveal timing, draw order and sync drift are
structurally invisible to the judge — A3 is the only thing standing behind them, and it only checks
that anchor phrases exist in the narration.

---

## Calibration

**Not done.** The rubric has never been checked against human judgement, so the gates are reasoned
rather than validated, and the holistic score is uncalibrated — a 3 means whatever the model means by
3 that day. Any claim that a change "improved quality" cannot currently be answered by this pipeline.

The procedure, when it happens:

1. Hand-score 30 scenes from the golden corpus against G1–G4 and the holistic scale.
2. Run the judge over the same 30.
3. Measure per-gate agreement. Any gate below 80% agreement gets its wording revised — the fix is
   almost always a sharper *fails when* clause, not a longer prompt.
4. Re-run. Record the final agreement rate; it is the number that justifies trusting the gate.

Re-calibrate whenever the model, the shape vocabulary, or a gate's wording changes. All three have
just changed.
