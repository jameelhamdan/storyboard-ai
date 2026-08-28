# Architecture

How the service is put together, and why it is put together that way. For the request/response
shape see [`api-contract.md`](api-contract.md); for what happens between accepting a job and
producing an MP4 see [`workflow.md`](workflow.md).

---

## 1. Shape of the system

Two processes and one dependency.

```
                    ┌──────────────┐
 client ───HTTP───▶ │   api        │──enqueue──┐
                    │  (Fastify)   │◀──state───┤
                    └──────────────┘           │
                                          ┌────▼─────┐
                                          │  redis   │  queue + job state
                                          └────▲─────┘
                    ┌──────────────┐           │
                    │  worker × N  │──state────┘
                    │ (BullMQ)     │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  shared workspace   object storage     providers
  (checkpoints,      (published         (LLM, TTS,
   scratch)           artifacts)         STT, Chromium)
```

**The API never generates anything.** `POST /v1/generate` validates the request shape, stages the
uploaded bytes into the shared workspace, writes job state, enqueues, and returns `202` with a
`job_id`. Everything that reads a file, calls a model or draws a frame happens in a worker.

**Workers are interchangeable.** `docker compose up --scale worker=N` starts N of them against the
same queue. Nothing is pinned to a worker, which is exactly why the workspace has to be shared —
see §5.

**Redis is the only hard dependency.** It carries both the queue (BullMQ) and job state. One
dependency rather than two was the deciding argument for BullMQ. `/v1/health` returns 503 when it
is unreachable, because an API that can neither enqueue nor read state is not serving.

---

## 2. Layering

Four layers, and the dependency rule points one way only:

```
interfaces/      Fastify routes, DTOs, OpenAPI, worker entry, config loading, composition root
    │ depends on
application/     use cases, the pipeline, stages, ports          (no provider knowledge)
    │ depends on
domain/          entities, value objects, policies               (no I/O, imports nothing)

infrastructure/  provider adapters, queue, storage, renderer     (implements application/ ports)
```

This is enforced by lint, not by convention. `npm run lint` fails the build if `domain/` imports
another layer, if `application/` reaches into `infrastructure/`, or if a provider SDK is imported
outside `infrastructure/`. `npm run deadcode` (knip) fails on unused files, exports or dependencies.

### What lives where

| Layer | Holds | Never holds |
|---|---|---|
| `domain/` | `VideoJob`, `Scene`, `Storyboard`, `Money`, `Duration`, the eight policies | anything async, anything vendor |
| `application/` | 13 pipeline stages, 4 use cases, 18 ports | a provider name, an SDK import, a YAML parse |
| `infrastructure/` | ffmpeg, Playwright, BullMQ, OpenAI, ElevenLabs, whisper.cpp adapters | business rules |
| `interfaces/` | HTTP, OpenAPI, worker entrypoint, config, DI | logic worth unit-testing |

### Policies are where the rules live

The eight classes in `domain/policy/` are pure functions over configuration — no I/O, nothing to
mock, so they carry the heaviest test coverage in the suite:

| Policy | Decides |
|---|---|
| `DurationPolicy` | target video length from content volume, and the word budget for it |
| `SubtitleSegmentationPolicy` | where a cue breaks, and the drift ceiling |
| `JudgeThresholdPolicy` | which gate failures block a scene |
| `RetryBudgetPolicy` | regenerate / fall back / fail the job |
| `CostCeilingPolicy` | the per-job spend circuit breaker |
| `SourcePrecedencePolicy` | which source wins when two contradict |
| `ScriptScopingPolicy` | every narration sentence must carry a resolvable citation |
| `PersonalisationPolicy` | how `student_context`, `style` and `direction` become one narration brief |

A stage that starts making a judgement call rather than orchestrating one belongs in a policy.

---

## 3. Ports and adapters

`application/port/` holds 22 interfaces. Each has at least one real adapter in `infrastructure/`,
and the model-facing ones also have a stub.

| Port | Real adapter | Stub |
|---|---|---|
| `LlmClientPort` | `OpenAiClient`, `GeminiClient` (plain `fetch`, no SDK) | — |
| `ScriptGeneratorPort` | `PromptedScriptGenerator` | `StubScriptGenerator` |
| `StoryboardGeneratorPort` | `PromptedStoryboardGenerator` | `StubStoryboardGenerator` |
| `VisualPlannerPort` | `PromptedVisualPlanner` | `StubVisualPlanner` |
| `QualityJudgePort` | `PromptedQualityJudge` | `StubQualityJudge` |
| `StoryPlanJudgePort` | `PromptedStoryPlanJudge` | `StubStoryPlanJudge` |
| `ImageSourcePort` | `WikimediaImageSource`, `UnsplashImageSource`, `PexelsImageSource`, `WebSearchImageSource` — one per provenance, resolved by id through `ImageSourceRegistry` | — |
| `WebSearchPort` | `GeminiGroundedSearch` (no extra credential), `BraveWebSearch` | — |
| `IllustrationFinderPort` | `CompositeImageSource` — asks the permitted sources in the order `ImageSourcePolicy` gives — wrapped by `TracingIllustrationFinder`, which draws a found diagram as strokes | — (absent when no key is configured) |
| `SpeechSynthesisPort` | `OpenAiSpeechSynthesizer`, `ElevenLabsSpeechSynthesizer`, `GeminiSpeechSynthesizer` | `StubSpeechSynthesizer` |
| `TranscriptionPort` | `WhisperCliTranscriber` | `StubTranscriber` |
| `WordAligner` (infrastructure-only) | `WhisperCliWordAligner`, `GeminiWordAligner`, `OpenAiWordAligner` — recovers word timings for a synthesiser that reports none | — |
| `SceneRendererPort` / `ScenePreviewPort` | `PlaywrightSceneRenderer` / `PlaywrightScenePreviewer` | — |
| `VideoEncoderPort` | `FfmpegAssembler` | — |
| `ObjectStoragePort` | `LocalObjectStorage` | — |
| `WorkspacePort` | `SharedVolumeWorkspace` | — |
| `JobQueuePort` / `JobConsumerPort` | `BullMqJobQueue` / `BullMqJobConsumer` | — |
| `JobRepositoryPort` | `RedisJobRepository` | — |

The stubs are deliberately **honest**: where there is genuinely no content, they report insufficient
content rather than fabricating a transcript. The one exception is `StubQualityJudge`, which passes
everything — it exists to exercise the pipeline's shape, and any number it reports is a placeholder.

### The composition root

`interfaces/composition/container.ts` is **the only file in the codebase that names a vendor
adapter.** Every driver choice is a ternary there:

```ts
const scriptGenerator = llm ? new PromptedScriptGenerator(llm, prompts) : new StubScriptGenerator();
```

Swapping a provider is one line in that file plus a new adapter — no change to `domain/`,
`application/`, or any stage. The lint rule keeping vendor imports out of every other file is what
makes that claim testable rather than asserted. (Fastify and pino do appear in `interfaces/http/`:
those files *are* the web adapter.)

`buildContainer` also exposes `stages`, so the worker and the end-to-end runner drive the same
list. A second assembly somewhere else would drift and end up testing a pipeline production does
not run.

**Two Redis connections, deliberately.** BullMQ requires `maxRetriesPerRequest: null` — it manages
its own blocking semantics. But that means a command issued while Redis is down retries forever,
which on a request path turns an outage into hung connections rather than a fast 503. So the read
path gets its own bounded connection and only the queue gets BullMQ's.

---

## 4. Configuration

Two layers, with a hard line between them:

- **`config/*.yaml`** — all behavioural spec: limits, thresholds, presets, pacing, judge thresholds,
  retry budgets, theme tokens. Versioned, reviewable, no secrets.
- **`.env`** — secrets and deployment endpoints only.

Two exceptions live in `.env` because the brief names and verifies them: `QUEUE_MAX_DEPTH` and
`WORKER_CONCURRENCY`. Both read `.env` first with the YAML value as fallback.

Per-video styles are in `config/styles.yaml` — two sentences each, one steering the script and one
steering the picture. Prose rather than numeric knobs because prose is what the model acts on: a
`density: 0.7` would have to be translated into a sentence before use, and that sentence is the part
worth reviewing. Adding a style is a config entry.

Voice slot metadata is in `config/voices.yaml`; the provider voice id for each slot is an `.env` key
(`VOICE_EN_FEMALE_1`, …), so swapping a voice never touches code.

`interfaces/config/loadConfig.ts` parses the YAML through zod schemas, resolves it into domain
objects, and produces one `ResolvedConfig`. **Nothing below `interfaces/` ever parses YAML or reads
`process.env`** — a stage receives `ctx.config` and nothing else.

Malformed or missing config fails at boot, not three stages into the first job. Two contract tests
enforce that the documentation cannot drift from what is actually read:

- `test/contract/env-example.test.ts` — `.env.example` and `envSchema` declare exactly the same keys.
- `test/contract/prompts.test.ts` — every prompt declares exactly the variables its adapter supplies.

### Prompts are files, not string literals

`prompts/*.md` are the live prompts. A `## System` heading is the system prompt, `## User` is the
user template, `{{placeholders}}` are filled by the adapter, and prose before the first heading is
notes for humans that is never sent. An unfilled `{{placeholder}}` throws before the call is made
rather than reaching the model as literal text.

They are the most-edited artefact in the service and the least likely to be edited by whoever wrote
the surrounding code, so they are plain Markdown a non-engineer can open. `PROMPT_HOT_RELOAD=true`
skips the cache while iterating; `PROMPT_DIR` points at a different set to A/B a whole batch.

---

## 5. Storage: two different things

These are separate ports because they have opposite lifetimes.

**`WorkspacePort` — job-scoped, ephemeral, shared.** The checkpoint, scratch audio, rendered
segments, scene previews. Discarded when the job reaches a terminal state; an orphan sweeper on a 5-minute
timer catches workspaces whose worker died after the final stage.

It is *shared* rather than local because BullMQ requeues a dead worker's job to **any** worker — a
checkpoint in one container's `/tmp` does not exist in the next. Locally that is a compose named
volume. A hosted deployment needs an adapter whose `localCopy` genuinely copies, so ffmpeg and
Playwright still get real paths — that is the one method the port exists to abstract.

**`SafeHttpClient` — every caller-supplied URL, and now every researched one.**
It resolves the hostname, checks the address against the private/link-local/metadata ranges, then
pins the connection to *that address* while leaving the URL addressed to the hostname — so TLS
verification, SNI and the `Host` header are all correct and there is still no window for DNS to
change its answer between the check and the connect. Pinning by rewriting the URL to the IP, which is
the obvious implementation, fails certificate validation on every HTTPS host on the internet.

**`ObjectStoragePort` — published, durable, presigned.** The four artifacts the caller receives:
`video.mp4`, `subtitles.srt`, `traceability.json`, `cost.json`. These outlive Redis job state, which
expires after `job.stateTtlSeconds`.

There is **one** implementation of each, because there is one deployment target. A hosted bucket is
a new adapter behind the same port plus one line in the composition root — which is what the port
is for. An S3 adapter and an object-storage workspace did exist, and were deleted: 221 lines and
11 MB of `@aws-sdk` that no test, script or e2e run had ever executed, for a deployment that does
not exist yet.

> `presignedUrl` returns a plain URL on local storage — there is nothing to sign. The API contract's
> expiry promise is therefore a property of whichever hosted adapter replaces it.

---

## 6. Errors

One envelope on every non-2xx, produced in one place — `interfaces/http/errorMapper.ts`. No stage or
use case constructs an HTTP response.

```json
{ "error": { "code": "UNSUPPORTED_FORMAT", "message": "...", "details": { } } }
```

Three distinctions the mapper exists to preserve:

- **`GENERATION_FAILED` has no HTTP mapping.** The request succeeded and the *job* failed, so it is
  reported through `GET /status`, never as a status code.
- **503 is not 500.** Redis unreachable is a dependency outage, not a bug in the request. 503 tells
  the caller to retry; 500 tells them to stop, and only one of those is true.
- **Internal messages are never echoed.** They can carry paths, hostnames, or a fragment of student
  content. The correlation id is how a 500 gets debugged.

Inside the pipeline, `DomainError` subclasses pass through `GenerationPipeline.wrap` untouched — an
`INSUFFICIENT_CONTENT` must not be relabelled as a generic failure. Everything else becomes
`GENERATION_FAILED` tagged with the stage that produced it. `JobCancelledError` also passes through:
cancellation is not a failure, and travels as an error only because that is how you unwind a stack.

---

## 7. Safety boundaries

Everything below is enforced in code and covered by `test/unit/security.test.ts`:

| Boundary | Where | What it stops |
|---|---|---|
| SSRF guard | `SafeHttpClient` | fetches to private ranges, non-http schemes, redirect chains |
| Magic-byte sniffing | `MagicByteSniffer`, `ValidateInputsStage` | a `.pdf` that is actually something else — the declared type is recorded, never trusted |
| Archive-bomb limits | `ArchiveGuard` | entry count, uncompressed size and compression ratio on PPTX/DOCX |
| HTML sanitisation | `HtmlSanitizer` | `<script>`, event handlers, inline `style` and external references in scene markup. Defence in depth now that the markup is generated rather than model-authored — a violation here is this service's bug, and `test/contract/vocabulary.test.ts` asserts every shape passes it untouched |
| Path traversal | `SharedVolumeWorkspace.pathFor`, `LocalObjectStorage.pathFor`, `/artifacts/*` | a key escaping its job directory or the storage root |
| Filename sanitisation | `readMultipart` | attacker-controlled upload filenames landing on disk |
| Cost ceiling | `CostCeilingPolicy`, checked at every stage boundary | a runaway regeneration loop burning money |

Text is the one type accepted on the client's word, because text has no executable interpretation: a
mislabelled binary produces unreadable characters the content thresholds reject, not code that runs.

---

## 8. Known gaps

Recorded here so they are not rediscovered as surprises:

- **The quality judge is a stub by default.** `StubQualityJudge` passes everything. With
  `LLM_DRIVER=openai` the scene judge is real and looks at a rendered screenshot, but nothing it
  reports is a measurement until the rubric is calibrated.
- **OpenAI TTS timings are recovered, not authoritative.** `/v1/audio/speech` returns audio without
  word timings, so `OpenAiSpeechSynthesizer` transcribes its own output to recover them — a second
  billed call per scene, metered into the `tts` line. `resolvePhrase` falls back to the longest
  leading prefix of an anchor, so one misheard word no longer drops the anchor entirely, but the
  timings are still a transcription of the audio rather than an alignment against the script.
  `elevenlabs` reports per-character alignment and remains strictly stronger; `openai` is the
  one-credential option.
- **Local storage does not expire URLs.** `presignedUrl` returns a plain URL, so the API contract's
  expiry promise is a property of whichever hosted adapter replaces it.
- **Audio- and image-only jobs report `INSUFFICIENT_CONTENT`** unless a real STT or vision driver is
  configured. Correct behaviour for a stub that reads nothing, not a bug.
- **Collision, clipping and text size are now measured, not judged.** They are properties of a
  laid-out page, so `render/page/measure.ts` reads them off the same settled frame the judge is
  screenshotted from. This reversed an earlier decision to delegate them to the vision judge, which
  a real run disproved: scene 0 of `out/20260827-202226-battery` shipped with its centre box
  covering the label beside it and passed all five gates with a holistic 4. Contrast is still not
  measured.
- **A board cannot overlap by construction, which is the stronger guarantee.** The model returns a
  `SceneDiagram` and `render/diagram/` lays it out with grid and flex only. The measurement above is
  the belt to that's braces — it catches a template regression, not a model mistake.
- **No rate limiting.** Excess load queues rather than erroring, and no `429` is ever returned. Add
  it at the gateway if you need one.
- **The judge has never been calibrated.** The gates are reasoned rather than validated against
  human judgement, and the holistic score is uncalibrated — so the pipeline cannot answer "did that
  change improve quality?" and neither can anyone reading its output. `docs/judge-rubric.md` §
  Calibration is the procedure; it has not been run.
- **Nothing judges the finished video, or animation over time.** Every assessment is one static
  frame per scene attempt. Reveal timing, draw order and sync drift are structurally invisible.
- **20-job concurrency is unverified.** Local checks cover isolation, queueing, requeue-on-kill and
  `--scale` at 3 and 6 jobs, with stub providers.
- **No full run against *real models* since the diagram rework.** The last live-model run
  (`out/20260827-202226-battery`) predates it entirely and is what motivated the rework. Every board
  shape is verified in a real browser by `test/integration/diagram-layout.test.ts`, and the whole
  pipeline is verified end to end with stub providers — but what neither exercises is a real model
  filling a `SceneDiagram`: whether it picks good nodes, whether its anchors match the narration,
  and what the judge makes of the result. That run is the next thing to do.
- **Cost figures are estimates.** Every number in `DEFAULT_PRICING` is a guess until an invoice
  lands, and the per-video-minute figure inherits that uncertainty. The target itself
  (`job.costTargetPerMinuteUsd`, currently $0.20) is a business decision rather than a fact about
  the pipeline, which is why it is config and not a constant — it moved from $0.10 to buy frontier
  models on every call.
