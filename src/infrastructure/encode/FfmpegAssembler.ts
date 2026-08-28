import { writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VideoEncoderPort, EncodeResult } from '@application/port/VideoEncoderPort.js';
import type { QualityPreset } from '@domain/media/QualityPreset.js';
import type { SubtitleCue } from '@domain/media/SubtitleCue.js';
import { FfmpegRunner } from './FfmpegRunner.js';

/**
 * Concat + mux + encode, and the audio side of the same tooling. ffmpeg is a
 * binary rather than a library here, which is why this adapter is language-
 * agnostic in the runtime comparison — nothing about it argues for Node or Python.
 */
export class FfmpegAssembler implements VideoEncoderPort {
  constructor(private readonly ffmpeg: FfmpegRunner = new FfmpegRunner()) {}

  public async assemble(input: {
    segmentPaths: readonly string[];
    audioPath: string;
    outputPath: string;
    preset: QualityPreset;
    subtitles?: { path: string; languageCode: string };
    signal?: AbortSignal;
  }): Promise<EncodeResult> {
    if (input.segmentPaths.length === 0) {
      throw new Error('Cannot assemble a video from zero rendered segments.');
    }

    const listPath = join(dirname(input.outputPath), 'concat.txt');
    // The concat demuxer parses this file; single-quote escaping is its documented
    // convention and the paths are ours, but a stray quote would still break it.
    await writeFile(
      listPath,
      input.segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );

    /**
     * Streams are mapped explicitly because there are two or three inputs.
     * ffmpeg's default mapping picks one stream per type by its own notion of
     * "best", which is fine with two inputs and stops being predictable once a
     * subtitle input joins them.
     */
    const subtitles = input.subtitles;

    /**
     * The output is bounded by the narration, explicitly.
     *
     * `-shortest` used to do this, and it is wrong the moment a subtitle track
     * joins the mux: it finishes encoding when the shortest *output* stream
     * ends, and the last cue almost always ends before the video does. A video
     * whose final scene has no subtitle was silently truncated to the last cue.
     */
    const narrationSeconds = await this.ffmpeg.durationSeconds(input.audioPath, input.signal);

    await this.ffmpeg.run([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-i', input.audioPath,
      ...(subtitles ? ['-i', subtitles.path] : []),

      '-map', '0:v:0',
      '-map', '1:a:0',
      ...(subtitles ? ['-map', '2:s:0'] : []),

      '-c:v', this.codecFor(input.preset),
      '-crf', String(input.preset.crf),
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',              // required for broad player compatibility
      '-r', String(input.preset.fps),
      '-c:a', 'aac', '-b:a', '128k',
      ...(subtitles
        ? [
            // mov_text is the only subtitle codec MP4 carries. The track is soft,
            // not burned in, so it stays switchable and costs a few KB.
            '-c:s', 'mov_text',
            '-metadata:s:s:0', `language=${iso639_2(subtitles.languageCode)}`,
            // On by default: a viewer who was handed only the MP4 should see
            // subtitles without hunting through a track menu.
            '-disposition:s:0', 'default',
          ]
        : []),
      '-movflags', '+faststart',          // metadata up front so playback starts immediately
      '-t', narrationSeconds.toFixed(3),  // see above: never `-shortest` with subtitles mapped
      input.outputPath,
    ], input.signal);

    const [durationSeconds, info] = await Promise.all([
      this.ffmpeg.durationSeconds(input.outputPath, input.signal),
      stat(input.outputPath),
    ]);

    return { path: input.outputPath, durationSeconds, sizeBytes: info.size };
  }

  public async concatAudio(input: {
    parts: readonly { path: string; gapAfterMs: number }[];
    outputPath: string;
    targetLufs: number;
    truePeakDb: number;
    signal?: AbortSignal;
  }): Promise<{ path: string; durationMs: number }> {
    if (input.parts.length === 0) throw new Error('Cannot concatenate zero audio parts.');

    // Build a filter graph that interleaves silence between scenes, then applies
    // EBU R128 normalisation across the whole thing — normalising per scene first
    // would make each scene individually correct and the sequence inconsistent.
    const inputs: string[] = [];
    const filters: string[] = [];
    const labels: string[] = [];

    input.parts.forEach((part, i) => {
      inputs.push('-i', part.path);
      filters.push(`[${i}:a]aresample=48000[a${i}]`);
      labels.push(`[a${i}]`);

      if (part.gapAfterMs > 0) {
        const seconds = (part.gapAfterMs / 1000).toFixed(3);
        filters.push(`aevalsrc=0:d=${seconds}:s=48000:c=mono[g${i}]`);
        labels.push(`[g${i}]`);
      }
    });

    filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[joined]`);
    filters.push(`[joined]loudnorm=I=${input.targetLufs}:TP=${input.truePeakDb}:LRA=11[out]`);

    await this.ffmpeg.run([
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[out]',
      '-ar', '48000', '-ac', '1',
      input.outputPath,
    ], input.signal);

    const seconds = await this.ffmpeg.durationSeconds(input.outputPath, input.signal);
    return { path: input.outputPath, durationMs: Math.round(seconds * 1000) };
  }

  public async writeSubtitles(cues: readonly SubtitleCue[], outputPath: string): Promise<string> {
    /**
     * CRLF throughout, including *between* a cue's own lines.
     *
     * `SubtitleCue.text` joins lines with `\n` because that is the right
     * separator for display; using it here produced a file with mixed endings,
     * which lenient players accept and strict parsers reject. The block ends
     * with a blank line, as the format expects.
     */
    const body = cues
      .map((cue) => [
        String(cue.index),
        `${cue.start.toTimecode(',')} --> ${cue.end.toTimecode(',')}`,
        ...cue.lines,
        '',
      ].join('\r\n'))
      .join('\r\n');

    await writeFile(outputPath, body, 'utf8');
    return outputPath;
  }

  public async probeDurationSeconds(path: string): Promise<number> {
    return this.ffmpeg.durationSeconds(path);
  }

  private codecFor(preset: QualityPreset): string {
    switch (preset.codec) {
      case 'h264': return 'libx264';
      case 'h265': return 'libx265';
      case 'vp9': return 'libvpx-vp9';
    }
  }
}

/**
 * MP4 tags subtitle tracks with ISO 639-2 three-letter codes; our language codes
 * are the two-letter 639-1 form. An unmapped code passes through — a wrong tag
 * is a mislabelled track, which beats failing the encode over metadata.
 */
function iso639_2(code: string): string {
  const map: Record<string, string> = { en: 'eng', es: 'spa' };
  return map[code] ?? code;
}
