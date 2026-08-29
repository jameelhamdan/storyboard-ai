# StudyCore Generation API

Turn a lecture PDF into a narrated whiteboard explainer video.

Upload course material — PDF, DOCX, PPTX, images, web pages, YouTube links, audio — and get
back an MP4 with subtitles, quiz questions, and a citation trail from every spoken claim to
the page it came from.

```bash
cp .env.example .env
docker compose up --build
```

That's the whole setup. Every provider defaults to a stub, so the pipeline runs end to end
with **no API keys and no spend** — you get a real MP4 out of a real PDF on the first try.

---

## What it makes

Not a slideshow. The video is drawn: each scene is a diagram from a fixed vocabulary of
thirteen shapes — a flow, a cycle, a comparison, a timeline — rendered as SVG strokes and
handwritten-style text that draw themselves in as the narrator reaches them.

**Diagrams build across scenes.** Consecutive scenes can share one board: it's laid out once
and grown a piece at a time, so the thing being explained stays on screen while the narration
walks around it. Parts already drawn recede so the current one stands out. This is the
difference between a lesson and a slideshow, and it's the main thing the renderer exists to do.

Every element is anchored to a *phrase* in the narration, not to a timestamp. After speech is
synthesized the whole timeline is rebuilt from the measured audio, so a box appears exactly
when its words are spoken — however long the voice took to say them.

---

## Using it

```bash
curl -X POST http://localhost:3000/v1/generate \
  -F "files=@your-lecture.pdf" \
  -F "output_language=en"
# → 202 {"job_id":"...","status":"queued","status_url":"/v1/status/..."}

curl http://localhost:3000/v1/status/<job_id>
```

Generation is asynchronous — poll `status_url` until it reports `completed`, then fetch the
`video_url`, `subtitle_url`, `traceability_url` and `cost_url` from the payload.

- API — <http://localhost:3000>
- Interactive OpenAPI docs — <http://localhost:3000/docs>
- Health — <http://localhost:3000/v1/health>

More workers, more throughput:

```bash
docker compose up --scale worker=4
```

Full request and response shapes are in [`docs/api-contract.md`](docs/api-contract.md).

### Shaping a single video

`style` changes how the video reads; `direction` is free text for anything a style doesn't
cover. Both are independent of `quality_preset`, which is pixels only.

```bash
curl -X POST http://localhost:3000/v1/generate \
  -F "files=@lecture.pdf" -F "output_language=en" \
  -F "style=exam_drill" \
  -F "direction=spend most of it on the Calvin cycle; skip the history"
```

| `style` | Narration | Board |
|---|---|---|
| `explainer` *(default)* | warm, one idea at a time | room to breathe |
| `lecture` | measured, result then reasoning | dense but ordered |
| `exam_drill` | brisk, leads with what is examinable | high density, revision-ready |
| `story` | narrative arc, concrete before abstract | sparse, one image per beat |
| `quick_recap` | assumes prior exposure, conclusions only | minimal |

Styles are two sentences each in `config/styles.yaml` — one shaping the script, one shaping
the picture. Adding one is a config entry, not code.

Other per-request options: `quality_preset` (720p/1080p/vertical/draft), `voice`,
`target_duration_seconds`, `student_context`, and `features` to toggle images, web research
and story-plan review.

---

## Running it with real models

Everything defaults to a stub. Fill in only the keys for what you want, and anything left
blank keeps its stub. `.env.example` lists every credential the service reads, grouped by
what it unlocks.

```bash
# One key for both the models and the voice:
LLM_DRIVER=gemini
TTS_DRIVER=gemini
GEMINI_API_KEY=<your-key>        # https://aistudio.google.com/apikey

# ...or OpenAI:
#LLM_DRIVER=openai
#TTS_DRIVER=openai
#OPENAI_API_KEY=<your-key>       # https://platform.openai.com/api-keys

# ...or ElevenLabs for speech only, which returns word alignment with the audio:
#TTS_DRIVER=elevenlabs
#ELEVENLABS_API_KEY=<your-key>
```

Then:

```bash
docker compose run --rm e2e            # source material in, MP4 out
npm run preflight                      # check keys and voices without spending
```

### Choosing a speech driver

The timeline is word-anchored, so what separates these is **where the word timings come
from**, not voice quality.

| `TTS_DRIVER` | Word timings |
|---|---|
| `elevenlabs` | Authoritative — per-character alignment returned with the audio |
| `openai` | Recovered — the adapter transcribes its own output, a second billed call |
| `gemini` | Recovered on the same key, given the narration text so it places known words rather than transcribing unknown ones |
| `stub` | Real timings over silence — free, and the whole timing chain still runs |

For `gemini`, local whisper.cpp is preferred when `STT_DRIVER=whisper` (free, and the audio
never leaves the machine); the boot log says which aligner is in use.

### Speech-to-text

Only needed for audio uploads and YouTube links without captions. **Local or nothing** —
there is no hosted option, so student audio never leaves the machine.

```bash
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make
./models/download-ggml-model.sh large-v3-turbo
```

Then set `STT_DRIVER=whisper`, `WHISPER_BINARY` and `WHISPER_MODEL_PATH`. It shells out to
the binary rather than binding in-process, so a missing toolchain never breaks `npm install`
for people who will never transcribe anything.

### Images on a board

A board is either drawn by the renderer or is a real photograph or published diagram found
by search, inlined and credited under the picture. **Nothing here generates imagery with a
model.** The feature turns on when a library is reachable:

```bash
#UNSPLASH_ACCESS_KEY=<your-key>   # photographs
#PEXELS_API_KEY=<your-key>        # a second photo library
#WIKIMEDIA_IMAGES=true            # published scientific diagrams, no key needed
```

With none of them set, every board is drawn.

### Web research

Off by default. When on, searched pages are fetched through the SSRF guard, chunked with
provenance, and cited exactly like an uploaded PDF — so a researched fact stays traceable.

`WEB_SEARCH_DRIVER=duckduckgo` needs **no credential at all**. `brave` needs a key and also
serves the `web_search` image source.

### Cost

Every job writes a `cost.json` broken down by stage, provider and model, and the status
payload carries a summary. Two model tiers are configured separately — the expensive one
reads the student's material and judges rendered boards, the cheap one describes diagrams
and writes the quiz:

| Variable | Used for |
|---|---|
| `GEMINI_MODEL_QUALITY` / `OPENAI_MODEL_QUALITY` | script, story-plan review, judging each board |
| `GEMINI_MODEL_VOLUME` / `OPENAI_MODEL_VOLUME` | scene diagrams, quiz |

**The quality tier is where the money goes** — it is the frontier model, it thinks before
answering, and thinking tokens are billed as output. If a budget tightens, that tier is the
first thing to look at, not the volume tier.

`job.costTargetPerMinuteUsd` in `config/default.yaml` is the target a finished job is
measured against; exceeding it logs a warning rather than failing the video.
`job.costCeilingUsd` is a per-job circuit breaker that *does* stop a runaway.

> Prices come from a table in `src/infrastructure/observability/CostMeter.ts` and are
> estimates until checked against a real invoice. Treat the figures as ratios.

---

## Changing what it generates

**Prompts** are `prompts/*.md` — plain Markdown, not string literals buried in code. A
`## System` heading is the system prompt, `## User` is the user template, and
`{{placeholders}}` are filled by the adapter. Prose before the first heading is notes for
humans and is never sent.

Edit one and rerun. Set `PROMPT_HOT_RELOAD=true` to skip the cache while iterating, or point
`PROMPT_DIR` at another folder to A/B a whole set. An unfilled `{{placeholder}}` throws
before the call is made rather than reaching the model as literal text.

**The e2e scenario** is `e2e/config.ts` — plain data, no logic. Edit it and rerun:

```bash
npm run e2e                          # the default scenario
npm run e2e -- --scenario spanish    # Spanish output from an English source
npm run e2e -- --file ./lecture.pdf  # your own file
npm run e2e -- --no-voice            # silent narration, no TTS spend
npm run e2e -- --keep                # leave the output directory in place
```

Every run writes to `out/<timestamp>-<scenario>/` and nothing is deleted, so runs can be
compared against each other.

---

## How it works

A request is validated and queued in under a second; a worker does everything else.

```
validate → [research] → ingest → transcribe → consolidate → script → [plan review]
  → storyboard → [judge] → synthesize → subtitles → quiz → render → assemble → publish
```

Four decisions explain most of the design:

**Provenance is attached at ingestion or it doesn't exist.** Every chunk of extracted text
carries its source and page or timestamp, and the script stage rejects any sentence without a
resolvable citation. That's what makes `traceability.json` an audit rather than a guess.

**The story is judged before it's drawn.** A beautifully drawn board of the wrong idea passes
every gate there is, so the scene set, its order and each scene's chosen shape are reviewed
before a board exists — the cheapest stage that can send work backwards.

**Everything that costs money happens before the render.** Render is the stage measured in
tens of minutes and the one most likely to be interrupted, so a job resumed after a render
failure re-pays for nothing at all.

**Re-timing closes synthesis.** Planned scene durations never match synthesized audio, so the
timeline is rebuilt from what was measured before a single frame is drawn. That re-time *is*
the narration/visual sync mechanism.

Stage by stage, with the reasoning: [`docs/workflow.md`](docs/workflow.md).

### Resuming a dead worker

Each stage's output persists to a **shared** job workspace, so a worker killed mid-job is
requeued and resumes from the last finished stage rather than re-paying for LLM and TTS calls
already made. Shared rather than local because the queue requeues to *any* worker — a
checkpoint in one container's `/tmp` doesn't exist in the next.

### Layout is not the model's job

The model describes what a board *contains* — nodes, edges, labels, and which step of the
build each arrives in — with no coordinates and no CSS. The renderer lays it out with grid and
flex, so **overlap is not something to detect; it's something the format can't express.**

This reversed an earlier design where the model wrote its own markup and a vision judge was
asked whether the result looked right. A real run disproved it: a board whose centre box
covered its neighbour passed every gate with a good score. Overlap, clipping and text size are
now measured off the laid-out page, for free, before any model sees it.

---

## Development

```bash
npm install
npm run verify     # typecheck + lint + dead-code + tests
npm test           # no external dependencies needed
```

`npm run dev:api` and `npm run dev:worker` need Redis: `docker compose up redis`.
Requires Node 20+ and `ffmpeg`/`ffprobe` on PATH — both are in the Docker images.

### Layout

```
interfaces/     Fastify routes, DTOs, OpenAPI, worker entry, composition root
application/    use cases + ports (no provider knowledge)
domain/         entities, value objects, policies (no I/O, imports nothing)
infrastructure/ provider adapters, queue, storage, renderer
```

The layering is enforced by lint, not convention: `npm run lint` fails if `domain/` imports
another layer, if `application/` reaches into `infrastructure/`, or if a provider SDK is
imported outside `infrastructure/`.

**`interfaces/composition/container.ts` is the only file that names a provider.** Swapping one
is a line there plus a new adapter behind the existing port.

`npm run deadcode` fails on unused files, exports or dependencies, and reports zero.

### Configuration

Two layers, deliberately separated:

- **`config/*.yaml`** — all behavioural configuration: limits, thresholds, presets, pacing,
  retry budgets. Versioned, reviewable, no secrets.
- **`.env`** — secrets and deployment endpoints only.

`QUEUE_MAX_DEPTH` and `WORKER_CONCURRENCY` are the two exceptions, read from `.env` first with
the YAML value as a fallback. Voice slot metadata lives in `config/voices.yaml` while each
slot's provider voice id is an `.env` key, so swapping a voice never touches code.

### Load testing

```bash
node scripts/load-test.mjs --jobs 1 --base http://127.0.0.1:3000   # baseline first
node scripts/load-test.mjs --jobs 3 --base http://127.0.0.1:3000
```

Run `--jobs 1` first — the under-load ceiling only means something relative to that baseline.
Use `127.0.0.1` rather than `localhost`: Node's `fetch` resolves the latter to IPv6 and the
server binds IPv4.

---

## Documentation

| | |
|---|---|
| [`docs/api-contract.md`](docs/api-contract.md) | Request and response shapes, error codes |
| [`docs/workflow.md`](docs/workflow.md) | A request's full path, stage by stage |
| [`docs/architecture.md`](docs/architecture.md) | How the system is put together, and why |
| [`docs/scene-contract.md`](docs/scene-contract.md) | What a board may contain and how it animates |
| [`docs/whiteboard-style.md`](docs/whiteboard-style.md) | The visual language and its design tokens |
| [`docs/judge-rubric.md`](docs/judge-rubric.md) | What the quality gates check, and what they don't |
| [`plan.md`](plan.md) | Original design rationale and decision log |

---

## Known limitations

Worth knowing before you rely on any of this:

- **The quality judge has never been calibrated.** Its gates are reasoned, not validated
  against human scoring, and the 1–5 holistic score means whatever the model means by it. The
  pipeline cannot currently tell you whether a change improved quality.
- **Nothing judges the finished video.** Every assessment is a still frame of a board. Reveal
  timing, draw order and audio sync drift are structurally invisible to it.
- **With `LLM_DRIVER=stub` the judge passes everything.** It exists to exercise the pipeline
  shape; nothing it reports on a stub run is a measurement.
- **Local storage does not expire URLs.** `presignedUrl` returns a plain URL — there is
  nothing to sign. The `presignTtlSeconds` promise becomes real with a hosted adapter.
- **Audio- and image-only jobs report `INSUFFICIENT_CONTENT`** unless a real STT or vision
  driver is configured. That is correct behaviour for a stub that reads nothing, not a bug.
- **Concurrency is verified at 3 and 6 jobs**, not at 20. Isolation, queueing, requeue-on-kill
  and `--scale` are all exercised; the numbers were taken with stub providers, and real model
  latency changes per-job wall time substantially.
- **There is no per-caller rate limiting.** Excess load queues rather than erroring, so no
  `429` is ever returned. Add one at the gateway if you need it.
- **Cost figures use estimated provider prices.** Real numbers need a real invoice.
