import type { ContentExtractorPort, ExtractionInput } from '@application/port/ContentExtractorPort.js';
import { SourceDocument, type SourceOrigin } from '@domain/content/SourceDocument.js';
import { ContentChunk } from '@domain/content/ContentChunk.js';
import { SourceRef } from '@domain/content/SourceRef.js';
import { Language } from '@domain/shared/Language.js';
import { UnsupportedFormatError } from '@domain/error/UnsupportedFormatError.js';
import type { SafeHttpClient } from '../http/SafeHttpClient.js';

interface TranscriptCue {
  readonly text: string;
  readonly startSeconds: number;
}

/**
 * Transcript first, because it costs nothing.
 *
 * YouTube serves caption tracks for most educational content, and a published
 * transcript is both free and better-punctuated than STT output. Only when there
 * is no track at all does the fallback matter — download the audio and run it
 * through the transcription port, which costs bandwidth and CPU.
 *
 * The fallback is not wired here: it needs `yt-dlp` in the image, which arrives
 * with the STT work at M3. Until then a video with no captions is refused with a
 * reason the caller can act on, rather than silently producing nothing.
 */
export class YouTubeExtractor implements ContentExtractorPort {
  public readonly name = 'youtube';

  constructor(
    private readonly http: SafeHttpClient,
    private readonly maxDurationSeconds: number,
  ) {}

  public supports(_mimeType: string, origin: SourceOrigin): boolean {
    return origin.type === 'youtube';
  }

  public async extract(input: ExtractionInput): Promise<SourceDocument> {
    if (input.origin.type !== 'youtube') {
      throw new UnsupportedFormatError('YouTubeExtractor was given a non-YouTube source.');
    }
    const { videoId, url } = input.origin;

    const page = await this.http.fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const html = page.body.toString('utf8');

    const durationSeconds = this.readDuration(html);
    if (durationSeconds && durationSeconds > this.maxDurationSeconds) {
      throw UnsupportedFormatError.overLimit(
        `video duration in seconds for '${url}'`, durationSeconds, this.maxDurationSeconds,
      );
    }

    const track = this.findCaptionTrack(html);
    if (!track) {
      throw new UnsupportedFormatError(
        `'${url}' has no caption track. Automatic transcription of YouTube audio is not yet available.`,
        { url, video_id: videoId, reason: 'no_caption_track' },
      );
    }

    const transcript = await this.http.fetch(track.url);
    const cues = this.parseTranscript(transcript.body.toString('utf8'));

    if (cues.length === 0) {
      throw new UnsupportedFormatError(
        `'${url}' returned an empty caption track.`,
        { url, video_id: videoId, reason: 'empty_caption_track' },
      );
    }

    // Group cues into paragraph-sized chunks. A caption cue is a couple of
    // seconds long — far too small to embed meaningfully or cite usefully.
    const chunks = this.groupCues(cues, 90).map((group, i) =>
      ContentChunk.of({
        id: `${input.sourceId}:t${i}`,
        text: group.text,
        refs: [SourceRef.timestamp(input.sourceId, group.startSeconds)],
        kind: 'transcript',
        ...(track.language ? { detectedLanguage: track.language } : {}),
        order: i,
      }),
    );

    return SourceDocument.of({
      id: input.sourceId,
      origin: input.origin,
      kind: 'transcript',
      chunks,
      ...(track.language ? { detectedLanguage: track.language } : {}),
    });
  }

  private readDuration(html: string): number | undefined {
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    return match?.[1] ? Number(match[1]) : undefined;
  }

  /** Prefers a manually-authored track; auto-generated captions are the fallback. */
  private findCaptionTrack(html: string): { url: string; language: Language | undefined } | undefined {
    const section = html.match(/"captionTracks":(\[.*?\])/s);
    if (!section?.[1]) return undefined;

    let tracks: { baseUrl?: string; languageCode?: string; kind?: string }[];
    try {
      tracks = JSON.parse(section[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"')) as typeof tracks;
    } catch {
      return undefined;
    }

    const chosen = tracks.find((t) => t.kind !== 'asr') ?? tracks[0];
    if (!chosen?.baseUrl) return undefined;

    return {
      url: chosen.baseUrl.replace(/\\u0026/g, '&'),
      language: Language.tryOf(chosen.languageCode),
    };
  }

  private parseTranscript(xml: string): TranscriptCue[] {
    return [...xml.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => ({
        startSeconds: Number(match[1]),
        text: decodeXmlEntities(match[2] ?? '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((cue) => cue.text.length > 0);
  }

  private groupCues(cues: readonly TranscriptCue[], targetWords: number): TranscriptCue[] {
    const groups: TranscriptCue[] = [];
    let buffer: string[] = [];
    let start = cues[0]?.startSeconds ?? 0;
    let words = 0;

    for (const cue of cues) {
      if (buffer.length === 0) start = cue.startSeconds;
      buffer.push(cue.text);
      words += cue.text.split(/\s+/).length;

      if (words >= targetWords) {
        groups.push({ text: buffer.join(' '), startSeconds: start });
        buffer = [];
        words = 0;
      }
    }
    if (buffer.length > 0) groups.push({ text: buffer.join(' '), startSeconds: start });

    return groups;
  }
}

/** Caption tracks are double-encoded: entities survive one XML parse. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '');
}
