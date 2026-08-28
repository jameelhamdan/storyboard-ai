import { spawn } from 'node:child_process';

/**
 * One way to invoke whisper.cpp's CLI, used by both the transcriber (source
 * audio → segments) and the word aligner (our own narration → word timings).
 *
 * Shared because the failure handling is the interesting part and it is
 * identical for both callers: a missing binary must read as "install
 * whisper.cpp", a hang must be killed rather than inherited by the job, and the
 * last few lines of stderr are the only thing that ever explains a non-zero
 * exit.
 */
export function runWhisperCli(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // argv array, never a shell string: the paths derive from a caller-supplied
    // filename and a shell would make that a command-injection surface.
    const child = spawn(binaryPath, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(signal ? { signal } : {}),
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Whisper did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run '${binaryPath}': ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Whisper exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}
