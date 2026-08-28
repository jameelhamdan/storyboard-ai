import { spawn } from 'node:child_process';

export interface FfmpegResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Thin wrapper over the ffmpeg/ffprobe binaries.
 *
 * Deliberately spawns argv arrays rather than shell strings: every path here is
 * derived from a job id or a filename that ultimately came from a caller, and a
 * shell string would make that a command-injection surface.
 */
export class FfmpegRunner {
  constructor(
    private readonly ffmpegPath = process.env['FFMPEG_PATH'] ?? 'ffmpeg',
    private readonly ffprobePath = process.env['FFPROBE_PATH'] ?? 'ffprobe',
  ) {}

  public run(args: readonly string[], signal?: AbortSignal): Promise<FfmpegResult> {
    return this.exec(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], signal);
  }

  public probe(args: readonly string[], signal?: AbortSignal): Promise<FfmpegResult> {
    return this.exec(this.ffprobePath, args, signal);
  }

  public async durationSeconds(path: string, signal?: AbortSignal): Promise<number> {
    const { stdout } = await this.probe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ], signal);

    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds)) {
      throw new Error(`ffprobe could not read a duration from '${path}'.`);
    }
    return seconds;
  }

  private exec(command: string, args: readonly string[], signal?: AbortSignal): Promise<FfmpegResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal ? { signal } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        reject(new Error(
          `Failed to run '${command}': ${error.message}. ` +
          'Both ffmpeg and ffprobe must be on PATH — the worker image installs them.',
        ));
      });

      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        // ffmpeg's diagnostics are all on stderr; surfacing the tail is the
        // difference between a debuggable failure and "exit code 1".
        else reject(new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`));
      });
    });
  }
}
