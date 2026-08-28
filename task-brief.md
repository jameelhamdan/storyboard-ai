# Outsourced Development Task Brief

**Project:** StudyCore
**Task title:** [Short, descriptive title]
**Prepared by:** [Your name] — [Role]
**Date:** [Date]
**Version:** 1.0

---

## 1. Background & Context

### Product overview — StudyCore

StudyCore is an AI-powered learning platform for students aged 18–24 (high school through Master's). The core concept is simple: a student feeds it any type of learning material, and the platform converts it into a complete, personalised learning system — locked strictly to what they uploaded.

**Supported inputs — anything a student encounters in real academic life:**
- Documents (PDFs, slides, Word files)
- Images and photos (blackboard shots, handwritten notes, diagrams)
- Website links and articles
- YouTube videos and online lectures
- Voice recordings (professor's lecture, personal voice notes)

**Outputs — a full learning system generated from those inputs:**
- Structured, cited notes (every fact linked back to the source page/timestamp)
- Flashcards with automatic spaced repetition scheduling
- Images and visual diagrams extracted or generated from content
- Podcast-style audio summaries
- Video summaries
- Interactive learning exercises and quizzes
- AI tutor / chat — Socratic mode by default, locked to the student's own uploaded material

The platform's core differentiator is **trust and source-lock**: the AI tutor never reaches outside the student's uploaded content. If something isn't in their files, it says so explicitly and points to the nearest relevant source instead of hallucinating. Every output is traceable back to the original material with clickable citations.

Exam preparation (national exams like Spain's PAU or the Dutch Eindexamen) is one use case — but the platform is designed for daily, year-round learning across any course, degree, or subject.

**Language scope:** This phase covers **English and Spanish only**. All UI, AI-generated outputs, and tutor interactions must fully support both languages. The architecture must remain extensible to add further languages in future phases without a rewrite.

- **Related systems/modules it touches:** Mainplatform that requests content generation and then consumes it

---

## 2. Scope of Work

Build a **self-contained, Dockerized microservice** that exposes a REST API for whiteboard video generation. StudyCore will call this service from its own backend flow — the developer has no access to or responsibility for any other part of the platform. The service receives course material as input and returns an S3 URL to the generated video plus a real-time subtitle file.

### In scope
- **Dockerized microservice** — fully containerised, runnable with `docker-compose up`, no external setup dependencies beyond environment variables
- **Single REST API endpoint** — accepts multipart/form-data or JSON with mixed input types and returns the result
- **Input handling** — the endpoint must accept any combination of:
  - Document files (PDF, DOCX, PPTX)
  - Images (JPG, PNG — e.g., blackboard photos, handwritten notes)
  - Website URLs (scrape and extract content)
  - YouTube video URLs (extract transcript/audio)
  - Voice/audio recordings (MP3, WAV — transcribe via STT)
  - **Student context fields** (optional but must be used by the pipeline when provided to personalise the video tone, depth, and focus):
    - `level` — e.g., `"high_school"`, `"bachelor"`, `"master"`
    - `goal` — e.g., `"exam preparation"`, `"understand the topic"`, `"quick review"`
    - `instructions` — free text from the student, e.g., `"focus on the key formulas"`, `"explain it simply"`
    - `student_profile` — structured object e.g. `{ "name": "Lucia", "age": 18, "language": "es", "strengths": ["math"], "weaknesses": ["theory"] }`
- **Content extraction & script generation** — distill inputs into a structured narration script, scoped strictly to the provided material (no hallucination, no external knowledge)
- **Whiteboard animation rendering** — Golobo AI-style visuals: hand-drawn aesthetic, progressive text reveal, animated diagrams, synced to narration
- **TTS voiceover** — AI-generated voice in English or Spanish (auto-detected from content), synced to animation timeline
- **Video assembly** — final MP4, 2–10 min scaled to content volume, hard cap at 10 min
- **S3 upload** — completed MP4 uploaded to a StudyCore-provided S3 bucket; S3 URL returned in API response
- **Subtitle file** — real-time `.SRT` subtitle file generated and returned alongside the S3 URL (either as a second S3 URL or as a direct file in the response)
- **API response structure** — clean JSON response:
  ```json
  {
    "status": "success",
    "video_url": "https://s3.amazonaws.com/...",
    "subtitle_url": "https://s3.amazonaws.com/...",
    "duration_seconds": 342,
    "language": "es",
    "voice": "female_1",
    "cost": {
      "total_usd": 0.57,
      "per_minute_usd": 0.10,
      "breakdown": {
        "llm_tokens_usd": 0.12,
        "tts_usd": 0.21,
        "stt_usd": 0.08,
        "rendering_compute_usd": 0.11,
        "storage_egress_usd": 0.05
      }
    },
    "quiz_questions": [
      {
        "question": "What is the main function of mitochondria?",
        "answer": "To produce energy (ATP) for the cell through cellular respiration.",
        "source_moment_seconds": 124
      },
      {
        "question": "Which process converts glucose into pyruvate?",
        "answer": "Glycolysis.",
        "source_moment_seconds": 287
      }
    ]
  }
  ```
  `quiz_questions` contains 3–7 questions pulled from key moments in the lecture. Each question includes the correct answer and the timestamp in the video where that concept was covered (`source_moment_seconds`). Questions must come strictly from the uploaded material — no invented content.
- **Error responses** — structured JSON errors with clear codes (e.g., `INSUFFICIENT_CONTENT`, `UNSUPPORTED_FORMAT`, `GENERATION_FAILED`)

### Explicitly out of scope
- Any StudyCore frontend or UI — video player, dashboard, progress indicator are StudyCore's responsibility
- Student editing of script, storyboard, or scenes — fully automated pipeline only
- Custom or user-uploaded voices — the 4 pre-approved TTS voices are fixed for this phase
- Dutch, Norwegian, or any language other than **English and Spanish**
- Any authentication or user management — the microservice is called service-to-service; auth is handled by StudyCore's flow (service on an internal network)
- Database or persistent storage beyond S3 — stateless service
- Custom animation style beyond the Golobo AI whiteboard reference — developer must study that style before starting

*(Listing what's out of scope prevents 80% of scope disputes.)*

---

## 3. Functional Requirements

| # | Requirement | Priority | Notes |
|---|-------------|----------|-------|
| FR-1 | Single POST endpoint accepts mixed inputs (files + URLs) and returns S3 video URL + subtitle URL | Must | Core API contract |
| FR-2 | Accepts all input types: PDF, DOCX, PPTX, JPG/PNG, website URL, YouTube URL, MP3/WAV | Must | Any combination in one request |
| FR-3 | Language auto-detected from content — narration and subtitles in English or Spanish accordingly | Must | No manual language param needed |
| FR-4 | Video length scales to content volume — minimum ~2 min, hard cap 10 min | Must | Longer content gets summarised, not truncated mid-sentence |
| FR-5 | Visual style matches Golobo AI: hand-drawn whiteboard aesthetic, progressive text reveal, animated diagrams synced to narration | Must | Developer must review golobo.ai before starting |
| FR-6 | TTS voiceover uses one of 4 pre-approved voices (1–2 female, 1–2 male per language). Voice is frame-synced — text on screen appears as it is spoken. Audio quality on par with Golobo AI narration | Must | Voice selection passed as optional param; defaults to female voice if not specified |
| FR-7 | Generated MP4 is uploaded to an S3 bucket and URL returned in response | Must | Developer sets up S3 and shares access with Saman |
| FR-8 | Real-time `.SRT` subtitle file generated and URL returned alongside video URL | Must | Timestamps must be accurate to the frame |
| FR-9 | Script and narration contain only content derived from the provided input — no external knowledge or hallucination | Must | Core trust principle of StudyCore |
| FR-10 | Structured JSON error response when input is insufficient, unsupported, or generation fails | Must | Codes: `INSUFFICIENT_CONTENT`, `UNSUPPORTED_FORMAT`, `GENERATION_FAILED` |
| FR-11 | Service runs fully inside Docker — `docker-compose up` is the only setup step beyond `.env` | Must | No manual dependency installation |
| FR-12 | End-to-end generation completes in under 5 minutes for a 10-min video | Must | Measured on standard cloud instance |
| FR-13 | Every factual claim in narration traceable to input source in internal metadata (not visible in video) | Should | Enables future citation overlay |
| FR-14 | Student context fields (`level`, `goal`, `instructions`, `student_profile`) accepted as optional input and used to personalise video tone, depth, pacing, and focus — a master's student gets a different video than a high school student from the same material | Must | All fields optional; pipeline must degrade gracefully if not provided |
| FR-15 | Response includes `quiz_questions` — 3–7 questions from key moments in the lecture, each with the correct answer and the video timestamp where the concept appears. Questions sourced strictly from uploaded material | Must | Timestamp field `source_moment_seconds` required per question |

---

## 4. Technical Requirements & Constraints

- **Delivery format:** Dockerized microservice with `Dockerfile` + `docker-compose.yml`. Must run with `docker-compose up` after setting `.env`. No host-level dependencies
- **Language / runtime:** Node.js 20+ — developer's choice, must be justified in the M1 technical proposal
- **API framework:** Express/Fastify (Node) + Typescript — must expose clean OpenAPI/Swagger docs
- **Video rendering approach:** Developer must propose and justify at M1 (e.g., Remotion + FFmpeg, Manim, custom canvas pipeline, third-party animation API). No rendering code written before proposal is approved
- **TTS — Voice requirements (fixed spec, not a developer choice):**
  - **4 voices total** — 1–2 female and 1–2 male, available in both English and Spanish
  - Voice quality must match or exceed Golobo AI narration — clear, warm, natural pacing, suitable for educational content. No robotic or generic TTS sound
  - All 4 voices must be pre-selected, tested, and approved by Saman at M1 before any video generation code is written. Developer proposes the voice samples; Saman confirms
  - Voice selection is baked into the service — configurable via `.env` (e.g., `VOICE_EN_FEMALE_1`, `VOICE_ES_MALE_1`) so voices can be swapped without code changes
  - TTS provider choice must support this voice set within the ≤ $0.10/min total cost constraint
  - Developer manages all TTS API keys in their own environment
- **STT (for voice/audio input):** Developer to propose (e.g., Whisper, Deepgram) — must handle lecture-quality audio
- **LLM for script generation:** Developer to propose — must enforce source-lock (generation grounded only in provided input, no retrieval from external sources)
- **Storage:** S3-compatible. Developer sets up the S3 bucket in their own repo/environment and shares read access with Saman. Bucket name and region must be configurable via `.env` — no hard-coded paths
- **Subtitle format:** `.SRT` — timestamps accurate to 100ms. Uploaded to same S3 bucket as video
- **Security:** No input content sent to third-party services beyond approved TTS/LLM/STT providers listed in the proposal. All credentials via environment variables — never in code or logs. No logging of raw student content
- **Environment variables:** Full `.env.example` file delivered with all required keys documented
- **Environment:** Git repo access, branch strategy, and staging details shared at kickoff

### Cost Constraint — Hard Requirement

> ⚠️ **IMPORTANT NOTE**
>
> **Quality comes first. Cost comes second.**
>
> The priority of this project is to match Golobo AI in both voice and visual quality — that is the bar, and it is non-negotiable. A cheaper video that sounds or looks worse than Golobo AI is not acceptable.
>
> Within that quality bar, the goal is to get the cost per generated video minute as low as possible — ideally under $0.10/min, and lower if achievable. The developer should treat this as an engineering challenge: same quality, smarter provider choices, lower unit cost.
>
> **If there is ever a trade-off between quality and cost, quality wins.**

> **Target: ≤ $0.10 per minute of generated video** — as low as possible within the quality constraint.

The developer must design the provider stack with unit economics in mind. The M1 technical proposal must include a **cost breakdown per video minute** covering every paid component (LLM tokens, TTS characters, STT minutes, rendering compute, S3 storage + egress). Proposals that exceed $0.10/min at the chosen quality level will not be approved.

- **Benchmark:** Golobo AI produces comparable-quality whiteboard videos at approximately $0.13/min. The target for this service is **≤ $0.10/min** — the developer must find the right provider combination to hit this
- **Cost is calculated end-to-end** — LLM + TTS + STT + rendering compute + storage — not just one component in isolation
- **No premium-tier defaults:** If a provider offers a cheaper tier at comparable quality (e.g., OpenAI TTS vs ElevenLabs premium), the cheaper option must be evaluated and justified either way
- **Cost estimate must be shown per video length:** $X for a 2-min video, $X for a 5-min video, $X for a 10-min video
- **Cost monitoring:** The service must log cost metadata per job (tokens used, TTS characters, audio seconds) so StudyCore can track actual per-video cost in production. These logs must never contain student content — metadata only

### Quality Benchmark

- Visual and audio quality must be **on par with Golobo AI educational videos** — this is the acceptance bar, not an aspiration
- The developer must watch at least 3 Golobo AI videos before starting and reference them explicitly in the M1 proposal
- Quality is assessed by Saman at M3 (feature-complete review) — if quality does not meet the bar, the developer is responsible for iterating before final delivery
- Quality dimensions assessed: narration clarity, animation smoothness, text readability, diagram accuracy, overall educational feel

### Scalability & Concurrency Requirements

This is a hard architectural requirement, not a nice-to-have. The service must be designed for parallel processing from day one.

- **Minimum concurrency:** 20 simultaneous generation jobs running in parallel without degradation, failure, or job interference
- **Async job model:** The API must be non-blocking. The POST endpoint accepts the request, enqueues the job, and immediately returns a `job_id`. The caller polls a separate `GET /status/{job_id}` endpoint or receives a webhook callback when the job completes
- **Job queue:** A proper task/job queue must be used (e.g., Celery + Redis, BullMQ, RQ, or equivalent) — developer to propose at M1. No threading hacks or in-memory queues
- **Worker architecture:** Workers must be horizontally scalable — spinning up additional worker containers via `docker-compose --scale worker=N` must increase throughput linearly
- **Job isolation:** Each job runs in full isolation — one job's failure must not affect any other running job. No shared mutable state between jobs
- **Job status API:**
  ```json
  GET /status/{job_id}
  {
    "job_id": "abc-123",
    "status": "queued | processing | completed | failed",
    "progress_percent": 65,
    "video_url": "https://s3.amazonaws.com/...",
    "subtitle_url": "https://s3.amazonaws.com/...",
    "error_code": null
  }
  ```
- **Graceful degradation:** If all workers are at capacity, new requests are queued (not rejected). Queue depth and worker count must be configurable via `.env`
- **Performance target:** Each individual job completes in under 5 minutes. Under a 20-job concurrent load, no single job should exceed 8 minutes
- **Resource limits:** Each worker container must define CPU and memory limits in `docker-compose.yml` to prevent one heavy job from starving others

---

## 5. Acceptance Criteria (Definition of Done)

The task is considered complete only when ALL of the following are met:

- [ ] `docker-compose up` starts the service with no additional setup beyond `.env`
- [ ] API endpoint accepts all supported input types (PDF, image, URL, YouTube, audio) in one request
- [ ] POST endpoint returns `job_id` immediately — non-blocking confirmed
- [ ] `GET /status/{job_id}` returns correct status, progress, and URLs on completion
- [ ] End-to-end test: real course material in → MP4 on S3 + `.SRT` file returned on job completion
- [ ] **Visual and audio quality matches Golobo AI educational videos** — assessed and approved by Saman at M3
- [ ] English and Spanish TTS both tested and confirmed natural-sounding and frame-synced
- [ ] Subtitle timestamps accurate — verified by spot-checking against video playback
- [ ] Script contains only content from provided input — hallucination test passed
- [ ] **Cost per generated video minute is ≤ $0.10** — verified with real provider invoices or per-call pricing, not estimates alone
- [ ] Cost breakdown per video length (2 / 5 / 10 min) delivered and approved at M1
- [ ] Per-job cost metadata logged (tokens, TTS chars, audio seconds) — no student content in logs
- [ ] **20 simultaneous jobs run in parallel without failure, timeout, or cross-job interference** — load test required as proof
- [ ] Single job completes under 5 min; under 20-job load no job exceeds 8 min
- [ ] `docker-compose --scale worker=N` increases throughput — verified with N=2 and N=4
- [ ] One failing job does not affect other running jobs — chaos test: kill one worker mid-job
- [ ] Queue depth and worker count configurable via `.env` — verified
- [ ] All error codes (`INSUFFICIENT_CONTENT`, `UNSUPPORTED_FORMAT`, `GENERATION_FAILED`) return structured JSON
- [ ] Requests beyond worker capacity are queued, not rejected — verified under overload
- [ ] OpenAPI/Swagger docs accessible at `/docs` when service is running
- [ ] `.env.example` delivered with all keys documented
- [ ] No secrets or student content in logs — verified
- [ ] Code reviewed and approved by Saman
- [ ] Technical documentation delivered (architecture, queue design, third-party services, setup guide, known limitations)
- [ ] Walkthrough session completed with Saman

---

## 6. Deliverables

1. Git repository with full source code — `Dockerfile`, `docker-compose.yml`, `.env.example`, and all service code
2. Technical proposal document (rendering approach, TTS/STT/LLM providers, pipeline architecture diagram) — due at M1, must be approved before rendering work begins
3. OpenAPI/Swagger docs auto-served at `/docs`
4. Test suite covering input parsing, script generation, and API response contract
5. Technical documentation: architecture overview, provider choices and rationale, known limitations, how to add a new language in future
6. Demo: real course material (PDF or YouTube URL) → generated MP4 on S3 + `.SRT` file — walkthrough with Saman

---

## 7. Timeline & Milestones

| Day | What happens |
|-----|-------------|
| Day 1 | Kickoff — Saman walks the developer through the brief. Developer sets up repo and shares access with Saman |
| Day 3 | **Progress report** — developer submits technical proposal (provider stack, voice samples, cost breakdown per video minute). Saman reviews and approves before build continues |
| Day 6 | **Progress report** — developer shares current build status, any blockers, and a preview of the pipeline working end-to-end (even if rough) |
| Day 8 | **Final delivery** — working Docker microservice, end-to-end demo, full documentation, load test results |

**Payment is released after Day 8 delivery is reviewed and accepted by Saman.**

**Total estimated effort:** [X days/hours]
---

## 8. Communication & Reporting

- **Primary contact:** Saman — [channel: Telegram / Slack / email — add preferred]
- **Progress updates:** Short async update every 2 days during the solo build phase (Days 3–7). No long reports — a few bullet points is fine
- **Blockers:** Raise within 24h — do not sit on them waiting for the next check-in
- **Response time:** Both sides reply within one business day
- **Meetings:** Day 1 kickoff call, Day 8 live demo + review, Day 10 final handover call

---

## 9. Code Quality & Working Standards

This is a greenfield microservice — the developer creates the repo from scratch. There is no existing codebase to follow. The standards below are mandatory.

**Architecture — Domain-Driven Design (DDD)**
- The codebase must follow DDD principles. Business logic lives in the domain layer and must not leak into API handlers, workers, or infrastructure code
- Clear layer separation: `domain` / `application` / `infrastructure` / `interfaces` — each with a single responsibility
- Domain entities and value objects must be explicit and meaningful (e.g., `VideoJob`, `NarrationScript`, `VoiceProfile`, `GenerationCost`) — no raw dicts passed around as business objects
- Use cases / application services orchestrate the pipeline — they do not contain business rules themselves
- Infrastructure (S3, TTS provider, LLM, queue) is behind interfaces/ports — swapping a provider must not require touching domain or application code

**General standards**
- Meaningful, descriptive naming — no abbreviations, no `data`, `result`, `stuff`
- Small, focused functions and classes — single responsibility throughout
- No business logic in API route handlers
- All configuration via environment variables — nothing hardcoded
- Secrets never committed to the repo under any circumstances

**Git & delivery**
- Clean commit history with meaningful messages — commits tell the story of what changed and why
- Small, reviewable PRs at each meaningful milestone — no single giant commit at the end
- `main` branch is always in a working state
- AI-assisted code is allowed — developer remains fully responsible for correctness, structure, and quality

**Documentation in code**
- Public interfaces and non-obvious logic must have docstrings/comments
- `README.md` covers: what the service does, how to run it locally, all `.env` variables explained, how to run tests

---

## 10. Commercial Terms

**Quality reference — this is what the output must match or exceed:**
- https://www.youtube.com/watch?v=GNXSL-EkfM4
- https://www.youtube.com/watch?v=8eRrD6pJDTo
- https://www.youtube.com/watch?v=5sVyvObt0q4
- Golobo AI educational videos (searchable on YouTube — developer must review before starting)

The developer must watch all reference videos and deliver output that is visually and audibly on the same level or better. Quality is assessed by Saman at Day 8 delivery.

**Pricing model — quality-first, cost-optimized**

Base payment is tied to the cost per generated video minute achieved at delivery. Quality must meet the reference bar above — pricing only applies once quality is confirmed accepted.

| Cost per minute achieved | Payment |
|--------------------------|---------|
| $0.13/min (Golobo AI baseline) | €300 |
| $0.12/min | €450 |
| $0.11/min | €600 |
| $0.10/min | €750 |
| $0.09/min | €900 |
| $0.08/min or lower | €1,050 |

Every cent per minute reduced below $0.13 adds **€150** to the payment. The goal is to go as low as possible — but quality is always the gate. A cheaper result that doesn't match the reference videos does not qualify for any tier.

- **Payment timing:** Full payment released after Day 8 delivery is reviewed and accepted by Saman
- **Cost per minute verified by:** actual API pricing documentation or real invoice from a test run — not estimates
- **Change requests:** Any work beyond the scope in Section 2 requires written agreement on price and timeline before starting

---

## 11. IP, Confidentiality & Access

- All work product, code, and documentation are the exclusive property of [Company] upon payment (work-for-hire)
- Developer signs [NDA / contractor agreement] before receiving access
- Access granted: [repo, staging env, specific services] — revoked at project end
- No sharing of code, data, or credentials with third parties
- No customer/production data used outside approved environments

---

## 12. Assumptions & Risks

- **Assumptions:** [e.g., "Staging environment is available from day 1", "API X is stable"]
- **Known risks:** [e.g., "Third-party API rate limits may affect testing"]
- **Escalation:** If an assumption breaks, both parties revisit timeline/price before continuing

---

## 13. Future Collaboration Opportunities

This project is the foundation of a larger roadmap. A developer who delivers quality work here will be the first considered for the following phases:

- **Additional languages** — expanding the service beyond English and Spanish (Dutch, Norwegian, and others as StudyCore grows into new markets)
- **New video formats** — same whiteboard pipeline adapted for different educational styles and content types (e.g., explainer animations, problem-solving walkthroughs, lecture summaries)
- **HTML web rendering** — rendering the generated content as interactive HTML for in-browser playback and embedding, keeping the same visual format

---

# not sure, suggest?

- Would this be helpful https://github.com/yogendra-yatnalkar/storyboard-ai
- also one important note that im not sure if its the required document or not , 
 but the time of creating a video should be at most 3/11 of the length of video it self :) 
 for example for a 10 mins video it  should not take more than 2.8 mins :) 
 Btw one things it says deadline is 8 days but couple of days delay is okay as well :) hopefully not needed but it’s okay

# Technical Criteria

- Typescript / nodejs
- This is going to be a microservice / keep in mind there might be a queue in front of it, and it's going to be distributed


