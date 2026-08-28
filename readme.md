# StudyCore Generation API

Turns course material — PDF, DOCX, PPTX, images, web pages, YouTube, audio — into a
whiteboard explainer video with subtitles, quiz questions and per-job cost metadata.

Design rationale lives in [`plan.md`](plan.md). This README is how to run it.

- [`docs/architecture.md`](docs/architecture.md) — how the system is put together, and why
- [`docs/workflow.md`](docs/workflow.md) — a request's full path, stage by stage
- [`docs/api-contract.md`](docs/api-contract.md) — request and response shapes

---

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

That is the only setup step. Every provider defaults to a stub, so the pipeline runs
end to end with **no credentials and no spend** — you get a real MP4 out of a real PDF.

- API: <http://localhost:3000>
- OpenAPI: <http://localhost:3000/docs>
- Health: <http://localhost:3000/v1/health>

Generate something:

```bash
curl -X POST http://localhost:3000/v1/generate \
  -F "files=@your-lecture.pdf" \
  -F "output_language=en"
# → 202 {"job_id":"...","status":"queued","status_url":"/v1/status/..."}

curl http://localhost:3000/v1/status/<job_id>
```

Scale workers:

```bash
docker compose up --scale worker=4
```

---

## What works today, and what does not

The build follows the milestone order in `plan.md` §10. **M2 is complete**: the whole
API surface, queueing, the fifteen-stage pipeline, checkpointing, Docker, and real
video output. The stages that need a model provider are stubbed behind their ports.

| Area | Status |
|---|---|
| API contract, OpenAPI, error envelope | ✅ real |
| Queue, worker scaling, cancellation, requeue-on-death | ✅ real |
| Checkpoint + resume across workers | ✅ real — verified by SIGKILL |
| PDF / DOCX / PPTX / web extraction, provenance | ✅ real |
| Consolidation, dedupe, conflict precedence | ✅ real (hashed embeddings, not semantic) |
| Timing chain: anchors → word timings → retime → render | ✅ real |
| Subtitles: SRT sidecar **and** a muxed `mov_text` track in the MP4 | ✅ real |
| ffmpeg render, concat, loudness, mux | ✅ real |
| Cost metering | ✅ real (prices are estimates until M1) |
| Generation time per job | ✅ real — `generation_seconds` on the status payload |
| Script + storyboard generation | ✅ real (OpenAI or Gemini) — stub by default |
| Speech synthesis + word timings | ✅ real — ElevenLabs (per-character alignment), OpenAI or Gemini (timings recovered by an aligner) |
| Quality judge, quiz, vision OCR | ✅ real (OpenAI or Gemini) — stub by default |
| Transcription | ✅ real (local whisper.cpp) — stub by default |
| Whiteboard aesthetic | ✅ real — every scene is a diagram (one of thirteen shapes), HTML/CSS for text and SVG for strokes, enforced by a pre-render gate |
| Story plan review before illustration | ✅ real — the scene set, order and per-scene shape are judged and revised before a board exists |
| Found images on a board | ✅ real — Wikimedia Commons, Unsplash, Pexels; inlined, credited, selectable per request |
| Web research grounding | ✅ real — searched pages enter as ordinary sources and are cited like an upload; off by default |
| Found diagrams draw themselves | ✅ real — contours traced once into SVG strokes, revealed like every other drawn line, deterministic per frame |
| Visual plan + vision judge | ✅ real — palette chosen per video, scenes judged from screenshots |

The stubs are deliberately *honest*: where there is genuinely no content, the pipeline
reports insufficient content rather than fabricating a transcript. The one exception is
the judge, which passes everything — it exists to exercise the pipeline shape, and any
quality number it reports is a placeholder until M7.

---

## Running it for real

Everything defaults to stubs, so `npm run e2e` produces a video with no keys and
no spend. To use the real models:

Every credential the service reads is listed in `.env`, grouped by what it
unlocks. Fill in the ones you need — anything left blank keeps its stub.

```bash
LLM_DRIVER=openai                   # one key, US endpoint, no residency guarantee
OPENAI_API_KEY=<your-key>           # https://platform.openai.com/api-keys

# ...or Gemini, on one key for both the models and the voice.
#LLM_DRIVER=gemini
#GEMINI_API_KEY=<your-key>          # https://aistudio.google.com/apikey

# Speech: either reuse the OpenAI key...
TTS_DRIVER=openai

# ...or ElevenLabs, which returns per-character alignment with the audio.
#TTS_DRIVER=elevenlabs
#ELEVENLABS_API_KEY=<your-key>      # https://elevenlabs.io/app/settings/api-keys

# Found images on a board are enabled by the presence of a key — no driver flag.
# Leave all three unset and every board is drawn, exactly as before.
#UNSPLASH_ACCESS_KEY=<your-key>     # photographs
#PEXELS_API_KEY=<your-key>          # photographs, a second library
#WIKIMEDIA_IMAGES=true              # published scientific diagrams; no key needed

# A request picks from those per job:
#   features.image_sources: ["wikimedia", "unsplash"]
#
# Every picture on a board either already exists or is drawn by the renderer.
# There is no image-generation model in this service.

# Rendering is always Chromium via Playwright, which the worker and e2e images
# install — so a full run works under docker compose, not on a bare host.

# Run it. `--no-voice` forces silent narration, so the whole timing chain and
# every visual is exercised without a TTS plan.
docker compose run --rm e2e
docker compose run --rm --entrypoint "npx tsx e2e/run.ts --no-voice --out /out --keep" e2e
```

> ElevenLabs' free plan cannot use Voice Library voices over the API. Either use a
> voice your workspace owns, or run `--no-voice` until you have a paid plan —
> `npm run preflight` checks this for you without spending anything.

### Choosing a TTS driver

The pipeline's whole timeline is word-anchored, so what separates these is where the
word timings come from — not voice quality.

| `TTS_DRIVER` | Timings | Cost of a 3-min video |
|---|---|---|
| `openai` | Recovered: the adapter transcribes its own audio with `whisper-1` | ~$0.107 (~$0.036/video-min) |
| `elevenlabs` | Authoritative: per-character alignment returned with the audio | ~$0.089 (~$0.030/video-min) |
| `gemini` | Recovered on the same key: the narration text and the audio go back to Gemini, which places known words rather than transcribing unknown ones. Local whisper.cpp takes precedence when `STT_DRIVER=whisper`; OpenAI is the last fallback. The boot log says which | ~$0.09 (~$0.03/video-min) |
| `stub` | Real timings over silence | free |

All three are inside the target. `openai` costs a little more because it
pays twice — once to synthesize, once to align — and that second call is metered into
the `tts` line of `cost.json` rather than hidden. Every figure is an estimate from the
configured pricing table until a real invoice lands.

### Speech-to-text

Only needed for audio uploads and YouTube links without captions.

| `STT_DRIVER` | What it does |
|---|---|
| `whisper` | Local whisper.cpp. **Student audio never leaves the machine** — the cleanest GDPR position, and free. Needs the binary and a model. |
| `stub` | Returns nothing, so an audio-only job reports `INSUFFICIENT_CONTENT` rather than inventing a transcript. |

There is no hosted option: transcription is local or nothing.

For local Whisper:

```bash
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make
./models/download-ggml-model.sh large-v3-turbo
```

then set `WHISPER_BINARY` and `WHISPER_MODEL_PATH`. It shells out to the binary
rather than binding in-process, so a missing toolchain never breaks
`npm install` for people who will never transcribe anything.

Two model tiers are configured separately, which is the cost decision made
concrete — the expensive model reads the student's material, the cheap one
grades our own output:

| Variable | Used for | Default |
|---|---|---|
| `OPENAI_MODEL_QUALITY` | script, visual plan, reading images, **judging each rendered board** | `gpt-4.1` |
| `OPENAI_MODEL_VOLUME` | scene diagrams, quiz | `gpt-4.1` |

The split is by how hard the judgement is, not by whose material it is. The scene
judge sits on the quality tier because it looks at a *screenshot* and decides
whether the board reads — the hardest perceptual call in the pipeline, and the
gate on every diagram. It is cheap to put there: it writes a verdict (~300 tokens)
where the storyboard writes markup (~2,200).

The volume tier dominates spend — roughly 20,000 output tokens per video against
1,600 for the quality tier — so the quality model can be much stronger without
moving the per-video-minute figure much.

At the **$0.20/video-minute** target (`job.costTargetPerMinuteUsd`) both tiers run
the frontier model: a 3-minute video costs about **$0.106/video-min**, or $0.125
if a quarter of scenes regenerate — roughly 40% under. The tiers still exist and
still matter: `volume` is ~9x the tokens, so it is the first thing to downgrade
if the budget tightens.

### Customising a single video

Two request fields, independent of `quality_preset` (which is pixels only):

```bash
curl -X POST http://localhost:3000/v1/generate \
  -F "files=@lecture.pdf" -F "output_language=en" \
  -F "style=exam_drill" \
  -F "direction=spend most of it on the Calvin cycle; skip the history"
```

| `style` | Narration | Board |
|---|---|---|
| `explainer` *(default)* | warm, one idea at a time | room to breathe |
| `lecture` | measured, result-then-reasoning | dense but ordered |
| `exam_drill` | brisk, leads with what is examinable | high density, revision-ready |
| `story` | narrative arc, concrete before abstract | sparse, one image per beat |
| `quick_recap` | assumes prior exposure, conclusions only | minimal |

Styles live in `config/styles.yaml` as two sentences each — one shaping the script,
one shaping the picture. Adding one is a config entry, no code. `direction` is free
text (≤ 500 chars) for anything a style doesn't cover; it is fenced in the prompt so
it cannot override the grounding and citation rules.

### Changing what gets generated

**`e2e/config.ts`** holds the scenario — source material, language, student
context, preset. It is plain data with no logic; edit it and rerun.

```bash
npm run e2e                          # the default scenario
npm run e2e -- --scenario spanish    # Spanish output from an English source
npm run e2e -- --file ./lecture.pdf  # your own PDF/DOCX/PPTX/TXT
npm run e2e -- --keep                # leave the output directory in place
```

### Changing the prompts

**`prompts/*.md`** are the live prompts — plain Markdown, not string literals in
code. A `## System` heading is the system prompt, `## User` is the user template,
and `{{placeholders}}` are filled by the adapter. Prose before the first heading
is notes for humans and is never sent.

Edit one and rerun. Set `PROMPT_HOT_RELOAD=true` to skip the cache while
iterating, or point `PROMPT_DIR` at a different folder to A/B a whole set.

An unfilled `{{placeholder}}` throws before the call is made rather than
reaching the model as literal text — and a contract test asserts every prompt
declares exactly the variables its adapter supplies.

---

## Local development

```bash
npm install
npm run verify           # typecheck + lint + dead-code + tests
npm test                 # no external dependencies
```

`npm run dev:api` and `npm run dev:worker` need Redis: `docker compose up redis`.

Requires Node 20+ and `ffmpeg`/`ffprobe` on PATH (both are in the images).

---

## Architecture

DDD layering, enforced by lint rather than convention:

```
interfaces/     Fastify routes, DTOs, OpenAPI, worker entry, composition root
application/    use cases + ports (no provider knowledge)
domain/         entities, value objects, policies (no I/O, imports nothing)
infrastructure/ provider adapters, queue, storage, renderer
```

`npm run lint` fails the build if `domain/` imports another layer, if `application/`
reaches into `infrastructure/`, or if a provider SDK is imported outside
`infrastructure/`. **`interfaces/composition/container.ts` is the only file that names
a provider** — swapping one is a line there plus a new adapter. (Fastify and pino do
appear in `interfaces/http/`: those files *are* the web adapter.)

`npm run deadcode` (knip) fails on unused files, exports or dependencies. It reports
zero — every file is reachable, every config key is read, and nothing is installed
that isn't imported.

### The pipeline

```
validate → ingest → transcribe → consolidate → script → storyboard → [judge]
  → synthesize → subtitles → quiz → render → assemble → publish
```

Three things are worth knowing:

**The judge runs before the render**, so a bad scene costs one regeneration rather
than a wasted 18,000-frame render.

**Re-timing closes the synthesis stage.** Planned scene durations never match
synthesized audio, so the storyboard timeline is rebuilt from measured audio before a
single frame is drawn. That re-time is the actual narration/visual sync mechanism, and
it is why rendering happens after synthesis rather than beside it.

**Everything that costs money runs before the render.** Subtitles and the quiz need
only the timed script, so they run early — which means a job interrupted during the
28%-of-the-work render stage resumes without re-paying for a single model call.

### Checkpointing and the shared workspace

Each stage's output persists to a **shared** job workspace, so a worker that dies
mid-job is requeued and resumes from the last finished stage rather than re-paying for
LLM and TTS calls already made.

The workspace is shared rather than local because BullMQ requeues to *any* worker — a
checkpoint in one container's `/tmp` does not exist in the next. Locally that is a
compose named volume; hosted, it is the object-storage adapter behind the same port.

---

## Configuration

Two layers, deliberately:

- **`config/*.yaml`** — all behavioural spec: limits, thresholds, presets, pacing,
  judge thresholds, retry budgets. Versioned, reviewable, no secrets.
- **`.env`** — secrets and deployment endpoints only.

Two exceptions live in `.env` because the brief names and verifies them:
`QUEUE_MAX_DEPTH` and `WORKER_CONCURRENCY`. Both read from `.env` first with the YAML
value as fallback.

Voice slot metadata is in `config/voices.yaml`; the provider voice id for each slot is
an `.env` key (`VOICE_EN_FEMALE_1`, …), so swapping a voice never touches code.

---

## Testing

```bash
npm test                                   # no external dependencies
node scripts/load-test.mjs --jobs 1 --base http://127.0.0.1:3000   # baseline
node scripts/load-test.mjs --jobs 3 --base http://127.0.0.1:3000   # concurrency
```

Run `--jobs 1` first: the under-load ceiling only means something relative to that
baseline. Use `127.0.0.1` rather than `localhost` — Node's `fetch` resolves the
latter to IPv6, and the server binds IPv4.

### What has actually been verified

Against a live stack (API + workers + Redis), with the stub providers:

| Check | Result |
|---|---|
| `POST` returns `job_id` immediately, non-blocking | ✅ slowest POST 0.0s |
| Full job: PDF in → MP4 + SRT + traceability out | ✅ 720p24 H.264/AAC, downloadable |
| 3 and 6 concurrent jobs | ✅ 3/3 and 6/6, distinct artifacts |
| Nothing rejected under load | ✅ excess queues, never 4xx |
| `--scale worker=N` raises throughput | ✅ verified at N=2 |
| Chaos: `SIGKILL` a worker mid-job | ✅ reclaimed and **resumed** from the checkpoint |
| Cancellation mid-pipeline | ✅ `cancelled` at every stage tested |
| Idempotency-Key | ✅ 202 → 200 replay, 409 on payload change |
| `UNSUPPORTED_FORMAT` / structured errors | ✅ correct code and detail |
| Per-job cost metadata, no student content | ✅ `$0.0139`/video-min |

The resume is the one worth calling out: a killed worker's job restarts on a
different process and skips every completed stage, so no LLM or TTS call is paid
for twice.

The suite covers the pure policies most heavily — they encode the brief's actual
requirements (duration bounds, subtitle drift, retry budgets, source precedence) and
have no I/O to mock. Also covered: the job state machine, the SSRF guard, archive-bomb
limits, HTML sanitisation, checkpoint resume, and the API contract.

---

## Known limitations

- **The quality judge is a stub that passes everything.** Nothing it reports is a
  measurement until M7.
- **20-job concurrency is not verified.** `plan.md` §11 is explicit about this: the
  local checks cover isolation, queueing, requeue-on-kill and `--scale`, at 3 and 6
  jobs. The brief's 20-job criterion needs hardware this has not been run on, and
  the numbers above are with stub providers — real LLM and TTS latency will change
  the per-job wall time substantially.
- **Local storage does not expire URLs.** `presignedUrl` returns a plain URL — there is
  nothing to sign. The `presignTtlSeconds` promise becomes real with a hosted adapter.
- **Audio- and image-only jobs report `INSUFFICIENT_CONTENT`** unless a real STT or
  vision driver is configured. This is correct behaviour for a stub that reads
  nothing, not a bug.
- **Layout is measured, and a board cannot overlap by construction.** The model describes
  each board — nodes, edges, labels, no coordinates — and the renderer lays it out with
  grid and flex, so overlap is not expressible. Overlap, clipping and text size are then
  measured off the laid-out page as a template-regression guard. This reversed an earlier
  decision to let the vision judge answer them, which a real run disproved: a board whose
  centre box covered its neighbour passed all five gates with a holistic 4.
- **The judge has never been calibrated.** Its gates are reasoned, not validated against
  human scoring, and the 1–5 holistic score means whatever the model means by it. So the
  pipeline cannot tell you whether a change improved quality, and neither can its output.
  `docs/judge-rubric.md` has the procedure; it has not been run.
- **There is no end-to-end video judge.** The stage that was meant to score the finished
  video was removed: it ran before subtitles existed and was called with no frames, so it
  scored the prompt text alone at full price. Scene-level judging from real screenshots
  (Stage B) is what assesses visual quality today. See `docs/judge-rubric.md`.
- **OpenAI TTS timings are recovered, not authoritative.** Its adapter transcribes its own
  audio to recover word timings — a second billed call, metered into the `tts` line.
  `elevenlabs` reports alignment with the audio and is strictly stronger.
- Cost figures use estimated provider prices. Real numbers need an invoice (M1).
