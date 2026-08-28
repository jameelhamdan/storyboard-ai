import { WordTiming } from './WordTiming.js';
import type { Duration } from '../shared/Duration.js';

/**
 * Maps the *written* form of a narration onto the timings measured for its
 * *spoken* form.
 *
 * The two differ because normalisation expands some tokens before synthesis —
 * "50%" is spoken as "fifty percent" — so the word sequences are not the same
 * length. Subtitles must display the written form ("50%") at the moment the
 * spoken form is heard.
 *
 * Most words are identical in both sequences. Matching those directly preserves
 * their exact synthesiser timing, and only the short divergent runs around an
 * expansion need interpolating. Distributing every word evenly instead — the
 * obvious shortcut — discards accurate timing for the whole scene to handle a
 * one-word difference, and pushes cue boundaries past FR-8's 100 ms tolerance.
 */
export function alignWrittenToSpoken(
  writtenWords: readonly string[],
  spoken: readonly WordTiming[],
  sceneStart: Duration,
  sceneDuration: Duration,
): WordTiming[] {
  if (writtenWords.length === 0) return [];
  if (spoken.length === 0) return evenlySpaced(writtenWords, sceneStart, sceneDuration);

  const key = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  /** Anchors: written index -> spoken index, for tokens that match exactly. */
  const anchors: { written: number; spoken: number }[] = [];
  let spokenCursor = 0;

  for (let w = 0; w < writtenWords.length && spokenCursor < spoken.length; w += 1) {
    const target = key(writtenWords[w]!);
    if (!target) continue;

    // Look a short way ahead only. An expansion is a handful of words; scanning
    // further starts matching a *later* repeat of a common word and drags the
    // timeline backwards.
    const horizon = Math.min(spoken.length, spokenCursor + 6);
    for (let sIndex = spokenCursor; sIndex < horizon; sIndex += 1) {
      if (spoken[sIndex]!.normalised === target) {
        anchors.push({ written: w, spoken: sIndex });
        spokenCursor = sIndex + 1;
        break;
      }
    }
  }

  if (anchors.length === 0) return evenlySpaced(writtenWords, sceneStart, sceneDuration);

  const out: WordTiming[] = [];

  for (let w = 0; w < writtenWords.length; w += 1) {
    const exact = anchors.find((a) => a.written === w);
    if (exact) {
      const timing = spoken[exact.spoken]!;
      out.push(WordTiming.of(writtenWords[w]!, timing.start.ms, timing.end.ms));
      continue;
    }

    // Unmatched: interpolate between the surrounding anchors, which bounds the
    // error to the length of one expansion rather than the whole scene.
    const before = lastAnchorBefore(anchors, w);
    const after = firstAnchorAfter(anchors, w);

    const startMs = before ? spoken[before.spoken]!.end.ms : sceneStart.ms;
    const endMs = after ? spoken[after.spoken]!.start.ms : sceneStart.ms + sceneDuration.ms;

    const gapStart = before ? before.written + 1 : 0;
    const gapEnd = after ? after.written : writtenWords.length;
    const gapCount = Math.max(1, gapEnd - gapStart);
    const position = w - gapStart;

    const span = Math.max(0, endMs - startMs);
    const per = span / gapCount;

    out.push(WordTiming.of(
      writtenWords[w]!,
      Math.round(startMs + position * per),
      Math.round(startMs + (position + 1) * per),
    ));
  }

  return out;
}

function lastAnchorBefore(
  anchors: readonly { written: number; spoken: number }[],
  index: number,
): { written: number; spoken: number } | undefined {
  let found;
  for (const anchor of anchors) {
    if (anchor.written < index) found = anchor;
    else break;
  }
  return found;
}

function firstAnchorAfter(
  anchors: readonly { written: number; spoken: number }[],
  index: number,
): { written: number; spoken: number } | undefined {
  return anchors.find((a) => a.written > index);
}

function evenlySpaced(
  words: readonly string[],
  start: Duration,
  duration: Duration,
): WordTiming[] {
  const per = duration.ms / Math.max(1, words.length);
  return words.map((word, i) =>
    WordTiming.of(word, Math.round(start.ms + i * per), Math.round(start.ms + (i + 1) * per)),
  );
}
