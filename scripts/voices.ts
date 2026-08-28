/**
 * Lists the voices the configured ElevenLabs key can actually see.
 *
 * Voice ids are account-visible and the premade set changes, so the defaults
 * shipped in .env are a starting point rather than a guarantee. This prints the
 * real ones, ready to paste into the VOICE_* slots.
 *
 *   npm run voices
 *   docker compose run --rm --entrypoint "npx tsx scripts/voices.ts" e2e
 */
import { loadDotenv } from '../src/interfaces/config/loadDotenv.js';

loadDotenv('.env', process.env);

const key = process.env['ELEVENLABS_API_KEY'];
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set in .env — nothing to list.');
  process.exit(1);
}

const response = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': key },
});

if (!response.ok) {
  console.error(`ElevenLabs rejected the key: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const body = (await response.json()) as {
  voices?: { voice_id: string; name?: string; labels?: Record<string, string> }[];
};

const voices = body.voices ?? [];
console.log(`\n  ${voices.length} voices visible to this key\n`);
for (const v of voices) {
  const labels = Object.values(v.labels ?? {}).join(', ');
  console.log(`  ${v.voice_id}  ${(v.name ?? '?').padEnd(18)} ${labels}`);
}
console.log('\n  Paste an id into VOICE_EN_FEMALE_1 (etc.) in .env.\n');
