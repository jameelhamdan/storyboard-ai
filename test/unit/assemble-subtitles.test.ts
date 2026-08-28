import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegAssembler } from '@infrastructure/encode/FfmpegAssembler.js';
import { QualityPreset } from '@domain/media/QualityPreset.js';
import type { FfmpegRunner } from '@infrastructure/encode/FfmpegRunner.js';

const preset = QualityPreset.of({ name: 'standard', width: 1280, height: 720, fps: 24, codec: 'h264', crf: 23 });

/** Captures the argv instead of shelling out, and writes the output ffmpeg would. */
function recordingRunner(): { args: string[][]; runner: FfmpegRunner } {
  const args: string[][] = [];
  const runner = {
    async run(argv: readonly string[]) {
      args.push([...argv]);
      await writeFile(argv[argv.length - 1]!, 'fake-mp4');
      return { stdout: '', stderr: '' };
    },
    async durationSeconds() { return 12.5; },
  } as unknown as FfmpegRunner;
  return { args, runner };
}

async function assemble(subtitles?: { path: string; languageCode: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'asm-'));
  const segment = join(dir, 'seg-000.mp4');
  await writeFile(segment, 'seg');
  const { args, runner } = recordingRunner();

  await new FfmpegAssembler(runner).assemble({
    segmentPaths: [segment],
    audioPath: join(dir, 'narration.wav'),
    outputPath: join(dir, 'video.mp4'),
    preset,
    ...(subtitles ? { subtitles } : {}),
  });

  return args[0]!;
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

/**
 * The subtitle track is muxed during assembly so a viewer handed only the MP4
 * still gets subtitles — the sidecar .srt is published as well. A wrong flag
 * here produces a video that looks fine and silently carries no text, so the
 * argv is pinned rather than eyeballed.
 */
describe('assembling with a subtitle track', () => {
  it('adds the SRT as a third input and maps all three streams explicitly', async () => {
    const argv = await assemble({ path: '/tmp/subs.srt', languageCode: 'en' });

    expect(argv).toContain('/tmp/subs.srt');
    // Default stream selection stops being predictable with three inputs.
    expect(argv.join(' ')).toContain('-map 0:v:0');
    expect(argv.join(' ')).toContain('-map 1:a:0');
    expect(argv.join(' ')).toContain('-map 2:s:0');
  });

  it('encodes as mov_text — the only subtitle codec MP4 carries', async () => {
    const argv = await assemble({ path: '/tmp/subs.srt', languageCode: 'en' });
    expect(flagValue(argv, '-c:s')).toBe('mov_text');
  });

  it('tags the track with an ISO 639-2 language code, as MP4 expects', async () => {
    const en = await assemble({ path: '/tmp/s.srt', languageCode: 'en' });
    const es = await assemble({ path: '/tmp/s.srt', languageCode: 'es' });

    expect(flagValue(en, '-metadata:s:s:0')).toBe('language=eng');
    expect(flagValue(es, '-metadata:s:s:0')).toBe('language=spa');
  });

  it('passes an unmapped language through rather than failing the encode', async () => {
    const argv = await assemble({ path: '/tmp/s.srt', languageCode: 'fr' });
    expect(flagValue(argv, '-metadata:s:s:0')).toBe('language=fr');
  });

  it('marks the track default, so it shows without a trip to the track menu', async () => {
    const argv = await assemble({ path: '/tmp/subs.srt', languageCode: 'en' });
    expect(flagValue(argv, '-disposition:s:0')).toBe('default');
  });

  it('leaves every subtitle flag off when there is no track to mux', async () => {
    const argv = await assemble();

    expect(argv).not.toContain('-c:s');
    expect(argv).not.toContain('-disposition:s:0');
    expect(argv).not.toContain('-metadata:s:s:0');
    // Video and audio are still mapped explicitly — only the subtitle map goes.
    expect(argv.join(' ')).toContain('-map 0:v:0');
    expect(argv.join(' ')).not.toContain('-map 2:s:0');
  });

  /**
   * Regression: `-shortest` finishes encoding when the shortest *output* stream
   * ends. Once a subtitle track is mapped, that is usually the last cue — so a
   * video whose closing scene has no subtitle was silently cut short. Caught by
   * assembling a real 2s clip whose last cue ended at 1.5s and getting 1.5s out.
   */
  it('bounds the output by the narration, never by the last subtitle cue', async () => {
    const argv = await assemble({ path: '/tmp/subs.srt', languageCode: 'en' });

    expect(argv).not.toContain('-shortest');
    // 12.5s is what the stubbed runner reports for the audio track.
    expect(flagValue(argv, '-t')).toBe('12.500');
  });

  it('bounds by the narration even with no subtitles, so both paths behave alike', async () => {
    const argv = await assemble();
    expect(argv).not.toContain('-shortest');
    expect(flagValue(argv, '-t')).toBe('12.500');
  });

  it('still produces a playable video without subtitles', async () => {
    const argv = await assemble();
    expect(flagValue(argv, '-c:v')).toBe('libx264');
    expect(argv).toContain('+faststart');
  });
});
