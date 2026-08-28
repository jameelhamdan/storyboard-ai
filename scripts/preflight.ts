/**
 * Validates every credential, model and voice the pipeline will use — without
 * generating anything.
 *
 * Every call here is a read: list models, read the subscription, fetch a voice.
 * None of them consume tokens, characters or quota. The point is to fail in
 * three seconds for free rather than nine stages into a paid run.
 *
 *   npm run preflight
 *   docker compose run --rm --entrypoint "npx tsx scripts/preflight.ts" e2e
 */
import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/interfaces/config/loadConfig.js';

const run = promisify(execFile);

type Status = 'ok' | 'warn' | 'fail' | 'skip';
const results: { status: Status; label: string; detail: string }[] = [];
const add = (status: Status, label: string, detail: string): void => {
  results.push({ status, label, detail });
};

/** Catches paste artefacts before they become a puzzling 401. */
function malformed(key: string): string | undefined {
  if (key !== key.trim()) return 'has leading or trailing whitespace';
  if (/^["'!]/.test(key)) return `starts with '${key[0]}', which is not part of any key format`;
  if (/["']$/.test(key)) return 'ends with a quote character';
  if (/\s/.test(key)) return 'contains a space';
  return undefined;
}

async function json(url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: response.status, body };
}

const config = loadConfig();
const env = config.env;

console.log('\n  Preflight — read-only checks, nothing is generated\n');
console.log(`  drivers     llm=${env.LLM_DRIVER} tts=${env.TTS_DRIVER} stt=${env.STT_DRIVER} storage=local\n`);

// ── Local prerequisites ─────────────────────────────────────────────────────
try {
  const { stdout } = await run('ffmpeg', ['-version']);
  add('ok', 'ffmpeg', stdout.split('\n')[0]?.slice(0, 48) ?? 'present');
} catch {
  add('fail', 'ffmpeg', 'not on PATH — render and encode cannot run');
}

try {
  await access(env.PROMPT_DIR, constants.R_OK);
  add('ok', 'prompts', `${env.PROMPT_DIR}/ readable`);
} catch {
  add('fail', 'prompts', `${env.PROMPT_DIR}/ is not readable`);
}

// ── OpenAI ──────────────────────────────────────────────────────────────────
if (env.OPENAI_API_KEY) {
  const bad = malformed(env.OPENAI_API_KEY);
  if (bad) {
    add('fail', 'OPENAI_API_KEY', `${bad} — fix this before anything else`);
  } else {
    const { status, body } = await json('https://api.openai.com/v1/models', {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    });
    if (status === 200) {
      const ids = new Set<string>((body.data ?? []).map((m: { id: string }) => m.id));
      add('ok', 'OPENAI_API_KEY', `valid — ${ids.size} models visible`);
      for (const [label, model] of [
        ['quality', env.OPENAI_MODEL_QUALITY], ['volume', env.OPENAI_MODEL_VOLUME],
      ] as const) {
        if (ids.has(model)) {
          add('ok', `model (${label})`, model);
        } else {
          add('fail', `model (${label})`, `'${model}' is not available to this key`);
        }
      }
    } else {
      add('fail', 'OPENAI_API_KEY', `${status} ${body?.error?.message ?? JSON.stringify(body).slice(0, 120)}`);
    }
  }
} else if (env.LLM_DRIVER === 'openai') {
  add('fail', 'OPENAI_API_KEY', 'not set, but LLM_DRIVER=openai');
} else {
  add('skip', 'OPENAI_API_KEY', 'not set');
}

// ── ElevenLabs ──────────────────────────────────────────────────────────────
if (env.TTS_DRIVER === 'elevenlabs') {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) {
    add('fail', 'ELEVENLABS_API_KEY', 'not set, but TTS_DRIVER=elevenlabs');
  } else if (malformed(key)) {
    add('fail', 'ELEVENLABS_API_KEY', malformed(key)!);
  } else {
    const headers = { 'xi-api-key': key };

    const sub = await json('https://api.elevenlabs.io/v1/user/subscription', headers);
    if (sub.status === 200) {
      const used = sub.body.character_count ?? 0;
      const limit = sub.body.character_limit ?? 0;
      const tier = sub.body.tier ?? 'unknown';
      const left = limit - used;
      // One default e2e run measured 2,474 characters.
      add(left >= 2474 ? 'ok' : 'warn', 'ElevenLabs quota',
        `tier '${tier}' · ${left.toLocaleString()} of ${limit.toLocaleString()} characters left` +
        (left >= 2474 ? ` (~${Math.floor(left / 2474)} runs)` : ' — under one run'));
    } else {
      add('warn', 'ElevenLabs quota',
        `${sub.status} ${sub.body?.detail?.message ?? ''}`.slice(0, 110));
    }

    // Each configured slot, because a voice the account cannot use fails at the
    // synthesize stage — the most expensive place to discover it.
    const slots = {
      VOICE_EN_FEMALE_1: env.VOICE_EN_FEMALE_1, VOICE_EN_MALE_1: env.VOICE_EN_MALE_1,
      VOICE_ES_FEMALE_1: env.VOICE_ES_FEMALE_1, VOICE_ES_MALE_1: env.VOICE_ES_MALE_1,
    };
    for (const [slot, id] of Object.entries(slots)) {
      const v = await json(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`, headers);
      if (v.status === 200) {
        add('ok', slot, `${v.body.name ?? '?'} (${v.body.category ?? 'unknown category'})`);
      } else if (v.status === 401) {
        add('warn', slot, `cannot verify — key lacks the voices_read permission`);
      } else {
        add('fail', slot, `${v.status} ${v.body?.detail?.message ?? 'not usable by this account'}`.slice(0, 110));
      }
    }
  }
}

// ── Optional: prove the configured voice actually synthesises ───────────────
// Opt-in with --probe-voice because, unlike everything else here, it spends:
// one short word, about 4 characters of quota. That is the only way to test a
// voice when the key lacks voices_read, and it is far cheaper than discovering
// the problem at the synthesize stage of a paid run.
if (env.TTS_DRIVER === 'elevenlabs' && process.argv.includes('--probe-voice') && env.ELEVENLABS_API_KEY) {
  const slot = env.VOICE_EN_FEMALE_1;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(slot)}/with-timestamps`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'test', model_id: env.ELEVENLABS_MODEL_ID }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) {
    const body: any = await response.json();
    const chars = body?.alignment?.characters?.length ?? 0;
    if (chars > 0) {
      add('ok', 'voice probe', `synthesised and returned ${chars} character timings`);
    } else {
      // Audio without alignment would silently fall back to even spacing.
      add('fail', 'voice probe', 'audio returned but no alignment — word timing would be fabricated');
    }
  } else {
    const detail = await response.text();
    add('fail', 'voice probe', `${response.status} ${detail}`.slice(0, 160));
  }
}

// ── Whisper ─────────────────────────────────────────────────────────────────
if (env.STT_DRIVER === 'whisper') {
  try {
    await run(env.WHISPER_BINARY, ['--help']);
    await access(env.WHISPER_MODEL_PATH, constants.R_OK);
    add('ok', 'whisper', `${env.WHISPER_BINARY} + model present`);
  } catch {
    add('fail', 'whisper', `${env.WHISPER_BINARY} or ${env.WHISPER_MODEL_PATH} missing`);
  }
}

// ── Will this actually produce real content? ────────────────────────────────
if (env.LLM_DRIVER === 'stub') {
  add('warn', 'LLM_DRIVER', "'stub' — the video renders, but the script is placeholder text");
}
if (env.TTS_DRIVER === 'stub') {
  add('warn', 'TTS_DRIVER', "'stub' — narration will be silence");
}

// ── Report ──────────────────────────────────────────────────────────────────
const icon: Record<Status, string> = { ok: '  ✓', warn: '  !', fail: '  ✗', skip: '  ·' };
for (const r of results) console.log(`${icon[r.status]} ${r.label.padEnd(20)} ${r.detail}`);

const failed = results.filter((r) => r.status === 'fail');
const warned = results.filter((r) => r.status === 'warn');
console.log('');
if (failed.length > 0) {
  console.log(`  ${failed.length} blocking problem(s). Fix these before spending anything.\n`);
  process.exit(1);
}
console.log(`  No blocking problems${warned.length > 0 ? `, ${warned.length} warning(s)` : ''}. Safe to run.\n`);
