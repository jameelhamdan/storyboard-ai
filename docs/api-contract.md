# API Contract

Conventional REST. Nothing clever: `snake_case` JSON, ISO-8601 timestamps, standard status codes,
one error envelope everywhere. Paths follow the brief (`POST /generate`, `GET /status/{job_id}`).

Base: `/v1`. OpenAPI is generated from the Fastify route schemas and served at `/docs`.

---

## POST /v1/generate

Accepts `multipart/form-data` (when files are attached) or `application/json` (URLs only).
Returns immediately — generation is asynchronous.

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `files` | file[] | one of `files`/`urls` | PDF, DOCX, PPTX, JPG, PNG, MP3, WAV. Type is sniffed, not trusted |
| `urls` | string[] | one of `files`/`urls` | Web pages and YouTube links |
| `output_language` | enum | yes | `en` \| `es` |
| `quality_preset` | enum | no | `draft` \| `standard` \| `high` \| `vertical`. Default `standard` — this is pixels only |
| `style` | string | no | How the video *reads*: `explainer` (default), `lecture`, `exam_drill`, `story`, `quick_recap`. See `config/styles.yaml` |
| `direction` | string | no | Free-text steer for this one video, ≤ 500 chars. E.g. "spend most of it on the worked example" |
| `features` | object | no | Turns the optional halves of the pipeline on or off for this job. See below |
| `voice` | string | no | Voice slot id, e.g. `es_female_1`. Defaults to the configured female slot for `output_language` |
| `target_duration_seconds` | int | no | Hint only; clamped to the preset's min/max |
| `student_context` | object | no | See below. All fields optional |
| `webhook_url` | string | no | Reserved — not implemented this phase; accepted and ignored |

`features`:
```json
{
  "images": true,
  "image_sources": ["wikimedia", "unsplash", "pexels"],
  "plan_review": true
}
```

| Field | Does |
|---|---|
| `images` | Allows the `illustration` board: a real photograph or published scientific diagram, found by search, credited under the picture. Off means every board is drawn |
| `image_sources` | Which libraries may be used, in preference order: `wikimedia`, `unsplash`, `pexels`, `web_search`, `generated`. An unknown value is a `400` |
| `plan_review` | Judges the whole story — scene set, order, shape per scene — before anything is illustrated, and rewrites the script if the judge objects. Off means the script goes straight to the boards |

**`image_sources` is a request, not an assertion about the server.** The job gets the intersection of
what it names and what the deployment has credentials for, so a caller never has to keep this list in
sync with the server's `.env`. Naming a source that *does not exist* is different — that is a typo,
and it is a `400` listing the valid values.

**Order is a preference, and only within a tier.** A caller who lists `pexels` before `unsplash` gets
Pexels first. What ordering cannot do is put a stock library ahead of Wikimedia for a diagram query:
which library suits which kind of question is a judgement about the material, and it belongs to the
server (`ImageSourcePolicy`). Every permitted source is still tried — a miss costs one search.

**An unstated field inherits the deployment default** from `config/default.yaml`, so naming one
feature never silently turns the other off. Both default on.

**Asking for a feature the deployment cannot provide is not an error.** With no image library
configured, `images: true` still produces drawn boards: the request states intent, and the
deployment decides what it can do. The resolved answer comes back on the status payload, so a caller
can see which it got.

`student_context`:
```json
{
  "level": "bachelor",
  "goal": "exam preparation",
  "instructions": "focus on the key formulas",
  "student_profile": {
    "name": "Lucia", "age": 18, "language": "es",
    "strengths": ["math"], "weaknesses": ["theory"]
  }
}
```

**Headers**

| Header | Notes |
|---|---|
| `Idempotency-Key` | Optional. Same key + same payload within the TTL returns the original job instead of creating a new one. Same key + *different* payload returns `409`. |

### Responses

`202 Accepted`
```json
{
  "job_id": "018f3c9a-7b21-7c4e-9a55-4b2d1e6f8a03",
  "status": "queued",
  "created_at": "2026-08-25T14:03:11Z",
  "status_url": "/v1/status/018f3c9a-7b21-7c4e-9a55-4b2d1e6f8a03"
}
```

| Code | When |
|---|---|
| `400` | Malformed request, missing required field |
| `409` | `Idempotency-Key` reused with a different payload |
| `413` | Request exceeds `input.maxRequestBytes` |
| `415` | A file's sniffed type is not supported |
| `422` | Well-formed but unusable — too little content, unreachable URL, over page/duration limits |

> Note: excess *load* never produces an error — jobs queue. There is no per-caller
> rate limiting in this phase, so no `429` is ever returned; add it at the gateway
> if you need one.

---

## GET /v1/status/{job_id}

Poll for progress and results. `200` in every non-terminal state; `404` if unknown.

A malformed id returns `404`, not `400`. An id that cannot exist is indistinguishable
from one that does not, and answering differently would confirm the id space to a
caller probing it — the job id is the only thing protecting an unauthenticated
`/status`.

**`queued` / `processing`**
```json
{
  "job_id": "018f3c9a-...",
  "status": "processing",
  "progress_percent": 65,
  "stage": "render",
  "created_at": "2026-08-25T14:03:11Z",
  "updated_at": "2026-08-25T14:06:02Z"
}
```

**`completed`**
```json
{
  "job_id": "018f3c9a-...",
  "status": "completed",
  "progress_percent": 100,
  "created_at": "2026-08-25T14:03:11Z",
  "completed_at": "2026-08-25T14:08:47Z",
  "generation_seconds": 336.0,

  "video_url": "https://.../video.mp4",
  "subtitle_url": "https://.../subtitles.srt",
  "traceability_url": "https://.../traceability.json",
  "cost_url": "https://.../cost.json",

  "duration_seconds": 342,
  "language": "es",
  "voice": "es_female_1",
  "quality_preset": "standard",
  "style": "exam_drill",
  "direction": "spend most of it on the worked example",
  "features": {
    "images": true,
    "image_sources": ["wikimedia", "unsplash"],
    "plan_review": true
  },

  "cost": {
    "total_usd": 0.11,
    "per_minute_usd": 0.019,
    "breakdown": {
      "llm_usd": 0.07, "tts_usd": 0.03, "stt_usd": 0.0,
      "rendering_usd": 0.01, "storage_usd": 0.0
    }
  },

  "quality": {
    "scenes_total": 48,
    "scenes_regenerated": 3,
    "scenes_fallback": 1,
    "holistic_score_mean": 4.1
  },

  "quiz_questions": [
    { "question": "…", "answer": "…", "source_moment_seconds": 124 }
  ]
}
```

`cost_url` is the same `cost` object above plus a per-provider and per-stage
split — token counts, TTS characters, call counts and estimated spend attributed
to the vendor that will invoice for each. Estimates from the configured pricing
table, not billed amounts.

`style` and `direction` are echoed back on the status payload, so a caller can see
what actually shaped the video rather than what they think they asked for. `features`
is **resolved rather than echoed** — it is what the job actually ran with after the
deployment defaults were applied, which is the only form of the answer worth having.
`image_sources` comes back empty whenever `images` is false, so the two fields can never
disagree in a way a caller has to reconcile.

**`direction` is untrusted text that reaches a model prompt.** It is length-capped,
stripped of control characters, and fenced in the prompt under an explicit rule that
grounding, citation and output-language requirements outrank anything inside it. It
can steer emphasis, tone and pacing; it cannot license the model to invent a source.
An unknown `style` is rejected rather than silently falling back to the default.

`subtitle_url` is a sidecar copy — the same cues are already muxed into `video.mp4`
as a selectable subtitle track, so a player given only the video still shows them.

`generation_seconds` is wall-clock time from the first worker picking the job up to
the video being published — not time since the request was accepted, and not time
since the most recent attempt. A job requeued after its worker died keeps the
original clock, because it is the same generation.

URLs are presigned and expire after `storage.presignTtlSeconds`. On the local storage
driver there is nothing to sign, so the URL does not expire — see
[`architecture.md`](architecture.md) §5.

**`failed`**
```json
{
  "job_id": "018f3c9a-...",
  "status": "failed",
  "failed_at": "2026-08-25T14:05:20Z",
  "error": {
    "code": "INSUFFICIENT_CONTENT",
    "message": "Provided material contains 180 usable words; 400 required.",
    "details": { "word_count": 180, "required": 400 }
  }
}
```

**`cancelled`** — `status`, `cancelled_at`.

---

## DELETE /v1/jobs/{job_id}

Cancels a queued or processing job. `202` with the job body; `404` unknown; `409` already terminal.

## GET /v1/health

`200` when serving. `503` when a dependency is down — Redis is the only hard one:
without it the API can neither enqueue nor read job state.
```json
{ "status": "ok", "checks": { "redis": "ok", "storage": "ok", "queue_depth": 0, "queue_active": 2 } }
```
Every probe is bounded (1.5s). The queue's connection retries indefinitely by
BullMQ's requirement, so an unbounded check could hang — and a load balancer reads
a hang as "still checking" and keeps sending traffic.

## GET /docs
OpenAPI UI.

---

## Error envelope

Every non-2xx response, without exception:
```json
{ "error": { "code": "UNSUPPORTED_FORMAT", "message": "...", "details": {} } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed request |
| `IDEMPOTENCY_CONFLICT` | 409 | Key reused with a different payload |
| `PAYLOAD_TOO_LARGE` | 413 | Over `maxRequestBytes` |
| `UNSUPPORTED_FORMAT` | 415/422 | Unsupported type, or over page/duration limits |
| `INSUFFICIENT_CONTENT` | 422 | Not enough usable material after consolidation |
| `NOT_FOUND` | 404 | Unknown job id, or its state has expired past `job.stateTtlSeconds` |
| `CONFLICT` | 409 | Cancelling a job that is already terminal |
| `GENERATION_FAILED` | — | Pipeline failure; surfaces in the status body, not as an HTTP error |
| `SERVICE_UNAVAILABLE` | 503 | A dependency (Redis) is unreachable. Retryable — distinct from `INTERNAL_ERROR`, which is not |
| `INTERNAL_ERROR` | 500 | Unhandled |

The three codes the brief names are all present. `GENERATION_FAILED` is deliberately not an HTTP
status — the request succeeded, the job failed, and it is reported through `GET /status`.

## Job states

```
queued ──> processing ──> completed
   │            │
   │            ├────────> failed
   └────────────┴────────> cancelled
```
`processing → queued` also occurs when a worker dies mid-job and the job is requeued.
