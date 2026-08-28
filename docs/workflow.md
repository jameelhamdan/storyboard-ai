# Workflow

What happens between `POST /v1/generate` and a downloadable MP4. For how the pieces are wired see
[`architecture.md`](architecture.md); for the exact request and response shapes see
[`api-contract.md`](api-contract.md).

---

## 1. The request path

`POST /v1/generate` does five things and nothing else. It must return a `job_id` immediately, so
anything that reads bytes belongs to the worker.

1. **Read the parts.** Multipart when files are attached, JSON when only URLs are. Size and count
   limits are enforced by `@fastify/multipart`, registered with the same config values the pipeline
   later reads. Upload filenames are sanitised before landing on disk.
2. **Validate the shape.** `generateRequestSchema` (zod, `.strict()`) in the handler rather than as
   a Fastify body schema — a multipart request arrives as parts, not a parsed object, so route-level
   validation would reject every upload, and JSON Schema's permissive default would silently accept
   unknown fields.
3. **Check idempotency.** Same `Idempotency-Key` + same payload fingerprint returns the original job
   as `200`. Same key + a *different* payload is a `409`, because quietly returning the wrong job is
   worse than an error the caller can see.
4. **Stage the sources.** `submission.json` plus the uploaded bytes go into the shared workspace
   under the new job id — before the job is queued, so whichever worker picks it up can read them.
5. **Save state and enqueue.** `202` with `job_id`, `status: "queued"` and `status_url`.

Preset and voice slot are resolved here too, because both can fail on the caller's input:
an unknown preset, an unknown voice slot, or a voice whose language contradicts `output_language`
are all `UNSUPPORTED_FORMAT` at submit time rather than a failed job five minutes later.

---

## 2. The worker path

A worker picks the job off the BullMQ queue and `ProcessGenerationJob` takes over. Before any stage
runs:

- **A job already marked `processing` is a reclaim.** Its previous worker died without releasing it;
  the queue requeued it, but nothing moved our own state back, because the process that would have
  done so is gone. It is put back to `queued`, then started — a *resume*, not a fresh start.
- **A terminal job is skipped**, and a job with no state is discarded as a stale queue entry.
- A per-job `PipelineContext` is built: the job, resolved config, a logger bound to the job id, a
  fresh cost meter, the workspace, and the abort signal. **Created per job and never shared** — two
  concurrent jobs cannot reach each other's state because neither holds a reference that could.

Then `GenerationPipeline.run` walks `STAGE_ORDER`. For each stage it:

1. throws if the job has been cancelled;
2. fails the job if the cost meter has already breached `CostCeilingPolicy`;
3. **skips the stage if its checkpoint already exists**, reading the output back instead;
4. otherwise executes it, writes the checkpoint, and reports progress.

Stages hold no reference to what runs before or after them. Each one's input is the previous one's
output, and the composition happens in `GenerationPipeline` — which is what makes every stage
independently testable with a hand-built input.

---

## 3. The fourteen stages

```
validate → ingest → transcribe → consolidate → script → [plan review] → storyboard → [judge]
  → synthesize → subtitles → quiz → render → assemble → publish
```

**Everything that spends money happens before `render`.** Render is the one stage
measured in tens of minutes and the one most likely to be interrupted; subtitles and
the quiz need only the *timed* script, which exists as soon as synthesis has measured
its audio. So a job resumed after a render interruption re-pays for nothing at all.

| # | Stage | Weight | Does |
|---|---|---|---|
| 1 | `validate` | 1 | Sniffs magic bytes, enforces source count and size limits. Rejects with `UNSUPPORTED_FORMAT` before anything is read or paid for |
| 2 | `ingest` | 6 | Runs the matching extractor per source (PDF/DOCX/PPTX/image/audio/web/YouTube). Every chunk carries `{sourceId, page \| timestamp}` — **provenance is attached here or it does not exist later** |
| 3 | `transcribe` | 8 | Local whisper.cpp over audio sources without text. Student audio never leaves the machine |
| 4 | `consolidate` | 5 | Merges exact and near-duplicate chunks, resolves conflicts by `SourcePrecedencePolicy`. Slides plus a recording of those slides would otherwise be narrated twice. Throws `INSUFFICIENT_CONTENT` below the thresholds |
| 5 | `script` | 8 | Quality-tier model writes the narration, then settles the visual plan. `PersonalisationPolicy` folds `student_context`, the chosen `style` and the caller's `direction` into one brief; `DurationPolicy` sets the target length and word budget; `ScriptScopingPolicy` rejects any sentence without a resolvable citation. It also picks each scene's **diagram shape** from a thirteen-value vocabulary — the one decision only this stage can make well, since it has the whole source in front of it. Normalisation runs last, so everything downstream sees one identical spoken form. A failed visual plan is never fatal — it falls back to the theme palette |
| 6 | `planReview` | 3 | Quality-tier model grades the **whole story before anything is drawn**: coverage of the material, ordering, one idea per scene, whether each scene's chosen shape fits what it says. On an objection the script is rewritten with the critique attached, up to `judge.maxPlanRevisions`. The better plan ships and the video always ships — a plan that never satisfies the judge goes on with its objections logged. Skipped when the request sets `features.plan_review: false` |
| 7 | `storyboard` | 9 | Volume-tier model *describes* the shape the script chose — nodes, edges, labels and `anchor` phrases, with no coordinates and no CSS — and `render/diagram/` lays it out. A board that overlaps or clips is not something the format can express. Fans out under `concurrency.storyboard` |
| 8 | `judgeStoryboard` | 8 | Stage A (free markup **and geometry** checks — overlap, clipping and text size measured off the laid-out page) then Stage B (a **quality-tier vision** call on what survives). Per scene: pass, regenerate with the failed gates and the judge's notes, or stop and **ship the best attempt**. Fans out under `concurrency.judge` |
| 9 | `synthesize` | 13 | TTS per scene under `concurrency.speechSynthesis`, then concatenation and loudness normalisation — and finally the **re-time**, which rebuilds the storyboard timeline from measured audio |
| 10 | `subtitles` | 1 | Cues from absolute word timings via `SubtitleSegmentationPolicy`, written as SRT. Drift over tolerance is logged loudly — a slightly-off subtitle beats no subtitle |
| 11 | `quiz` | 1 | 3–7 questions from the *timed* script, so `source_moment_seconds` is exact rather than estimated |
| 12 | `render` | 28 | Chromium draws frames, ffmpeg encodes segments, fanned out under `concurrency.renderSegments`. Per-segment resume: an already-encoded segment is not redrawn |
| 13 | `assemble` | 5 | Concatenates segments, muxes the narration track, and muxes the subtitles as a `mov_text` track — soft, not burned in, and marked default |
| 14 | `publish` | 4 | MP4, SRT, `traceability.json` and `cost.json` to object storage, presigned — then records the final cost and reclaims the workspace |

Weights sum to 100 and are the progress scale — `StageName.ts` throws at import time if they stop
summing to 100, because the reported percentage would otherwise silently stop meaning what the API
contract says it means. Render dominates because it does.

### Three ordering decisions worth knowing

**The story is judged before it is drawn.** Every other judge in this pipeline grades *execution* —
whether one board is legible, grounded and well composed. None of them can ask whether the video
should have had this scene at all, or whether scene two needed something scene five explains, and by
the time a board exists those answers are settled: a beautifully drawn board of the wrong idea passes
every gate there is. `planReview` is also the cheapest stage that can send work backwards, which is
why it sits immediately after the script rather than after the storyboard.

**The judge runs before the render.** A bad scene costs one regeneration rather than a wasted
18,000-frame render.

**Re-timing happens at the end of synthesis, before anything is drawn.** Planned scene durations
never match synthesized audio, so the timeline is rebuilt from what was measured. That re-time
*is* the narration/visual sync mechanism, and it is why rendering happens after synthesis rather
than beside it.

---

## 4. Checkpointing and resume

The pipeline writes **one** checkpoint document, `checkpoint.json`, after every stage. It holds the
list of stages already finished and the whole carry as JSON. On resume, a worker reads it, rebuilds
the carry, and restarts at the first stage not in that list — so it never re-pays for an LLM or TTS
call already made.

One document rather than one file per stage because every stage's output is a superset of the
previous stage's: per-stage files re-wrote the same script and consolidated content on every save.

The workspace layout for one job:

```
<job-id>/
  submission.json              staged by the API before the job was queued
  checkpoint.json              completed stages + the carry
  06-previews/scene-NNN-aN.png the frame each scene was judged on, per attempt
  07-audio/scene-N.wav, narration.wav
  09-segments/seg-NNN.mp4      per-segment render resume
  10-video/video.mp4
  11-subtitles/subtitles.srt
  12-traceability/traceability.json, cost.json
```

Objects are serialised through `pipeline/codec.ts` rather than by structural cloning: domain objects
have behaviour, and a checkpoint has to round-trip back into the same classes. The carry codec keys
every field by name, which is why each stage's output is a *record* — a bare domain object has
nothing for the codec to key by, and would be silently dropped on resume.

Scene previews are keyed by attempt number, so a regenerated scene does not overwrite the image its
predecessor was judged on — which is what makes a critique traceable after the fact.

**Verified by SIGKILL**: killing a worker mid-job requeues it, and the replacement resumes with the
completed stages skipped. `test/unit/pipeline.test.ts` covers the same path in miniature, and
`test/unit/checkpoint-carry.test.ts` guards the codec against silently dropping a field.

---

## 5. Failure, retry, cancellation

**Retryable failure.** A non-domain error below `job.maxAttempts` leaves the job `processing` and
rethrows, so BullMQ requeues it. The workspace is deliberately *not* discarded — checkpoints are what
make the retry a resume.

**Terminal failure.** A `DomainError`, or exhausting the attempt cap, marks the job `failed` with the
error's own code and details, and discards the workspace. `GET /status` reports it in the body;
there is no HTTP error, because the request itself succeeded.

**Cancellation is not a failure.** `DELETE /v1/jobs/{id}` marks the job cancelled and removes it from
the queue; a running job notices at its next stage boundary. It is cooperative rather than a kill.

Two details that took a bug each to get right:

- The abort signal propagates into child processes, so a job cancelled while ffmpeg is running
  surfaces as *ffmpeg's* abort error, not `JobCancelledError`. Any error raised after the signal
  fired is therefore treated as a consequence of cancellation.
- The worker re-reads the job from Redis before writing the cancellation, because `DELETE` already
  mutated the stored copy while this worker still held a `processing` version. Writing ours back
  would silently undo it. `RedisJobRepository.save` also guards this in Lua: **nothing may
  un-terminalise a job.**

**Cost ceiling.** Checked at every stage boundary, not inside stages: a runaway regeneration loop is
the realistic way a job burns money, and the retry budget alone bounds retries per scene rather than
total spend. It *fails* the job rather than degrading it — a job already over its ceiling and only
part-way through will not get cheaper by continuing.

---

## 6. Progress and polling

Progress is persisted at every stage boundary, so `GET /status` reflects real work rather than a
guess. Long stages also report partial credit within themselves — `ingest`, `transcribe`,
`storyboard`, `judgeStoryboard`, `synthesize` and `render` all call `ctx.reportProgress` as they go.

Progress is **monotonic by construction**: it is derived from completed stage weights and never set
directly, and `VideoJob.advanceTo` refuses to move it backwards. A resumed job must never appear to
regress.

Job state expires from Redis after `job.stateTtlSeconds`, after which `/status` returns `404`. The
published artifacts outlive it in object storage.

---

## 7. What the caller ends up with

| Artifact | Contents |
|---|---|
| `video.mp4` | The whiteboard explainer, at the requested preset, **with the subtitles muxed in** as a selectable `mov_text` track marked default |
| `subtitles.srt` | The same cues as a sidecar, for players and pipelines that want the file separately |
| `traceability.json` | Every narration sentence **that states a source fact**, its video timestamp, and the `SourceRef`s it derives from — what a hallucination audit runs against. Narration may also contain up to one *teaching* sentence per scene (a hook, an analogy, a transition) which asserts nothing and cites nothing; `spoken_narration` carries everything the viewer heard, `narration` carries the claim set |
| `cost.json` | Token usage and estimated spend per provider and per stage. No student content |

Plus, in the status body: `quiz_questions` (3–7, each with an exact `source_moment_seconds`), the
`cost` summary, the `quality` verdict, and `generation_seconds` — wall-clock time from the first
worker picking the job up to the video being published. A job requeued after its worker died does
not restart that clock, because it is the same generation.

---

## 8. Running it yourself

```bash
docker compose up --build          # full stack, stub providers, no credentials, no spend
npm run e2e                        # the scenario in e2e/config.ts
npm run e2e -- --no-voice          # silent narration: exercises the whole timing chain, no TTS spend
npm run verify                     # typecheck + lint + dead-code + tests
```

`e2e/config.ts` holds each scenario as plain data with no logic — source material, language, student
context, preset. Edit it and rerun.

Every run writes to `out/<timestamp>-<scenario>/` and **nothing is deleted afterwards**, so runs can
be compared against each other. Each directory holds the artifacts, the job workspace (checkpoint
and the scene previews the judge looked at), and `timing.json` — total generation time, the
realtime factor, and per-stage seconds.

The runner fails fast when a driver is selected without its credential, and it *measures* whether
the narration is audible rather than assuming it: a TTS misconfiguration that returns empty audio
otherwise produces a video that looks completely fine and plays silent.
