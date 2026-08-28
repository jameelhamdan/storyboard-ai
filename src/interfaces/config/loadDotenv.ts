import { readFileSync } from 'node:fs';

/**
 * Minimal .env loader for local development.
 *
 * In Docker, compose's `env_file` populates the environment before the process
 * starts and this finds nothing to do. It exists so `npm run dev:*` behaves the
 * same way without requiring Node 20.6's --env-file or a dependency.
 *
 * Existing environment variables always win: an explicit `FOO=bar npm start`
 * must not be silently overridden by a stale .env.
 */
export function loadDotenv(path = '.env', env: NodeJS.ProcessEnv = process.env): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // no .env is normal in production
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key || key in env) continue;

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
