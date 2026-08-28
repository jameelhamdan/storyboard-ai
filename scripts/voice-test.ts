/**
 * Synthesises about five seconds of speech and writes it to ./out, so the voice
 * can actually be listened to before committing it to a full run.
 *
 * Tries every configured slot, because a plan restriction may block some voice
 * ids and not others — and the cheapest way to find a working one is to ask.
 * Each probe is one word (~4 characters); only a slot that passes goes on to
 * spend the ~80 characters the real sample costs.
 *
 *   docker compose run --rm --entrypoint "npx tsx scripts/voice-test.ts" e2e
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/interfaces/config/loadConfig.js';
import { createLogger } from '../src/infrastructure/observability/logger.js';
import { ElevenLabsSpeechSynthesizer } from '../src/infrastructure/speech/ElevenLabsSpeechSynthesizer.js';

/** ~5 seconds at a normal narration pace. */
const SAMPLE = 'Photosynthesis converts light energy into chemical energy stored in glucose.';

const config = loadConfig();
const env = config.env;
const outDir = process.env['VOICE_TEST_OUT'] ?? '/out';

if (!env.ELEVENLABS_API_KEY) {
  console.error('\n  ELEVENLABS_API_KEY is not set in .env.\n');
  process.exit(1);
}

const slots = {
  VOICE_EN_FEMALE_1: env.VOICE_EN_FEMALE_1,
  VOICE_EN_MALE_1: env.VOICE_EN_MALE_1,
  VOICE_ES_FEMALE_1: env.VOICE_ES_FEMALE_1,
  VOICE_ES_MALE_1: env.VOICE_ES_MALE_1,
};

async function probe(id: string): Promise<string | undefined> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}/with-timestamps`,
    {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'test', model_id: env.ELEVENLABS_MODEL_ID }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.ok) return undefined;
  const body = await response.text();
  try {
    return (JSON.parse(body).detail?.message ?? body).slice(0, 120);
  } catch { return body.slice(0, 120); }
}

console.log('\n  Probing each configured voice with one word (~4 characters)\n');

let working: { slot: string; id: string } | undefined;
for (const [slot, id] of Object.entries(slots)) {
  const error = await probe(id);
  if (error) {
    console.log(`  ✗ ${slot.padEnd(20)} ${error}`);
  } else {
    console.log(`  ✓ ${slot.padEnd(20)} works`);
    working ??= { slot, id };
  }
}

if (!working) {
  console.log('\n  No configured voice can be used by this account over the API.');
  console.log('  Nothing further was spent.\n');
  process.exit(1);
}

console.log(`\n  Synthesising ${SAMPLE.length} characters with ${working.slot}…\n`);

// Through the real adapter, not a raw call: this exercises the code the
// pipeline uses, so a pass here means the pipeline's TTS stage will pass.
const synthesizer = new ElevenLabsSpeechSynthesizer(
  {
    apiKey: env.ELEVENLABS_API_KEY,
    modelId: env.ELEVENLABS_MODEL_ID,
    outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
    requestTimeoutMs: env.TTS_TIMEOUT_MS,
  },
  config.resolved.voices,
  createLogger({ level: 'warn', redactPaths: [], pretty: true }),
);

await mkdir(outDir, { recursive: true });
const outputPath = join(outDir, 'voice-test.mp3');

const voice = [...config.resolved.voices.values()].find((v) => v.providerVoiceId === working.id)
  ?? [...config.resolved.voices.values()][0]!;

const result = await synthesizer.synthesize({ text: SAMPLE, voice, outputPath });

console.log(`  audio        ${outputPath}`);
console.log(`  duration     ${(result.durationMs / 1000).toFixed(2)}s`);
console.log(`  characters   ${result.characterCount}`);
console.log(`  word timings ${result.wordTimings.length}`);
console.log('');
for (const w of result.wordTimings.slice(0, 8)) {
  console.log(`    ${String(w.start.ms).padStart(6)}ms  ${w.word}`);
}
console.log(`\n  Listen:  open out/voice-test.mp3\n`);
