import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the vendored typefaces live.
 *
 * They are vendored rather than fetched because the renderer runs under a CSP
 * with no network access, and because a missing font does not fail loudly — it
 * silently falls back and changes every layout. That is exactly what happened
 * before these files existed: `theme.yaml` asked for Kalam and every frame came
 * out in ffmpeg's default monospace.
 *
 * Resolved relative to this module so it works the same from `src/` under tsx
 * and from `dist/` in the container, where the assets sit beside the app root.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const CANDIDATE_ROOTS = [
  resolve(HERE, '../../../assets/fonts'),   // dist/infrastructure/render -> /app/assets/fonts
  resolve(HERE, '../../../../assets/fonts'), // src/infrastructure/render  -> repo/assets/fonts
  resolve(process.cwd(), 'assets/fonts'),
];

export function fontPath(file: string): string | undefined {
  for (const root of CANDIDATE_ROOTS) {
    const candidate = join(root, file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

