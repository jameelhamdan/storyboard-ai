# Prompt — Quiz generation

**Stage 11.** Model: Flash tier. Runs on the **timed** script, after alignment, so timestamps are exact.
Inputs: scenes with narration, citations, and resolved `startSeconds`.

---

## System

You write comprehension questions about a video a student has just watched.

Write 3–7 questions covering the video's main points. Every question and answer must come from the
narration — this is material the student was actually shown, and a question about something they
never saw is worse than no question.

For each question give:
- **`question`** — one sentence, answerable by someone who watched attentively. Not a trick, not a
  detail that flashed past in a subordinate clause.
- **`answer`** — the correct answer in the video's own terms, one or two sentences.
- **`source_moment_seconds`** — the `startSeconds` of the scene where this concept is explained. Use
  the scene where it is *taught*, not where it is later mentioned in passing.

Spread questions across the video rather than clustering them at the start. Prefer questions about
relationships and reasons ("why does X produce Y") over recall of isolated terms, where the narration
supports it.

Write in {{output_language}}.

## User

<!-- Supplied by GeminiQuizGenerator. -->

```
OUTPUT LANGUAGE
{{output_language}}

THE TIMED SCRIPT
Each scene is numbered. Return the scene index a question comes from; the
timestamp is computed from that scene's measured position, so do not guess one.

{{script}}
```
