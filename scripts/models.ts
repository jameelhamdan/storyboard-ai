/**
 * Lists the OpenAI models the configured key can actually see, cheapest-looking
 * first. Model ids change faster than any hard-coded default can keep up with,
 * so this answers "what can I actually put in OPENAI_MODEL_*" from the account
 * itself rather than from memory.
 *
 *   npm run models
 */
import { loadDotenv } from '../src/interfaces/config/loadDotenv.js';

loadDotenv('.env', process.env);

const key = process.env['OPENAI_API_KEY'];
if (!key) {
  console.error('OPENAI_API_KEY is not set in .env — nothing to list.');
  process.exit(1);
}

const response = await fetch('https://api.openai.com/v1/models', {
  headers: { authorization: `Bearer ${key}` },
});

if (!response.ok) {
  console.error(`OpenAI rejected the key: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const body = (await response.json()) as { data?: { id: string }[] };
const ids = (body.data ?? []).map((m) => m.id).sort();

// Chat-capable families only: embeddings, audio, image and moderation models
// cannot serve the generation stages and would only be noise here.
const chat = ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/embed|audio|realtime|image|tts|whisper|moderation|transcribe/.test(id));

console.log(`\n  ${chat.length} chat-capable models visible to this key\n`);
for (const id of chat) console.log(`  ${id}`);
console.log(`\n  "nano" and "mini" variants are the cheap ones.`);
console.log('  Put one in OPENAI_MODEL_QUALITY / OPENAI_MODEL_VOLUME in .env.\n');
