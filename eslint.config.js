// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * The layer arrows from plan.md §6, enforced rather than documented.
 *
 *   interfaces/     -> application, domain, infrastructure (composition root only)
 *   application/    -> domain
 *   domain/         -> nothing
 *   infrastructure/ -> application (implements ports), domain
 *
 * Plus the rule that makes provider-swapping real: no vendor SDK may be
 * imported outside infrastructure/.
 */

const VENDOR_SDKS = [
  '@aws-sdk/*', 'openai', 'playwright', 'playwright-core',
  'bullmq', 'ioredis', 'fluent-ffmpeg', 'fastify', '@fastify/*', 'sharp',
  'mammoth', 'unpdf', 'pdfjs-dist', 'fast-xml-parser', 'subsrt-ts', 'linkedom',
  '@mozilla/readability', 'bottleneck', 'p-retry', 'pino', 'file-type', 'eld',
];

const deny = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
});

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit', overrides: { constructors: 'no-public' } }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Use SafeHttpClient — it is the SSRF guard for caller-supplied URLs (plan.md §4 stage 1).',
        },
      ],
    },
  },

  // domain/ imports nothing. Not another layer, not a library.
  {
    files: ['src/domain/**/*.ts'],
    rules: deny(
      ['@application/**', '@infrastructure/**', '@interfaces/**', ...VENDOR_SDKS],
      'domain/ imports nothing — it is pure entities, value objects and policies (plan.md §6).',
    ),
  },

  // application/ depends only on domain and its own ports.
  {
    files: ['src/application/**/*.ts'],
    rules: deny(
      ['@infrastructure/**', '@interfaces/**', ...VENDOR_SDKS],
      'application/ depends only on ports and domain — no provider knowledge (plan.md §4).',
    ),
  },

  // infrastructure/ may implement ports and use vendors, but never reaches up.
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: deny(
      ['@interfaces/**'],
      'infrastructure/ is wired by the composition root; it never imports from interfaces/.',
    ),
  },

  // Only the composition root names a vendor at the interfaces layer.
  {
    files: ['src/interfaces/**/*.ts'],
    ignores: ['src/interfaces/composition/**', 'src/interfaces/config/**'],
    rules: deny(
      ['@aws-sdk/*', '@google-cloud/*', '@google/genai', 'bullmq', 'ioredis', 'playwright', 'fluent-ffmpeg'],
      'Bind adapters in interfaces/composition/container.ts — it is the only file that names a vendor (plan.md §5).',
    ),
  },

  /**
   * Provider adapters call fixed, compiled-in endpoints — the Vertex host, the
   * Azure TTS host — never a URL a caller supplied. The SSRF guard exists for
   * the opposite case, and routing a constant endpoint through it would add
   * DNS-pinning and range checks that protect against nothing while making a
   * provider outage look like a validation failure.
   *
   * `image/` is the one that needs explaining. Its search calls go to fixed
   * vendor hosts like the others, but the *download* follows a URL that came
   * back from that search — so it is not compiled in. It is still not
   * caller-supplied: an authenticated vendor API over TLS chose it, and it
   * points at that vendor's CDN. SafeHttpClient would pin DNS through redirect
   * chains those CDNs depend on, turning working downloads into validation
   * failures while defending against a threat the response never carried. The
   * cap that does matter there — response size — is enforced in `fetchBytes`.
   *
   * `search/` is the same case as an LLM adapter: fixed vendor endpoints,
   * authenticated, over TLS. The URLs a search *returns* are a different matter
   * entirely — those are untrusted, and they are fetched by `WebPageExtractor`
   * through `SafeHttpClient`, which is the whole reason research feeds URLs into
   * the ordinary ingestion path instead of reading pages itself.
   *
   * Scoped to these directories rather than suppressed inline: a per-call
   * disable comment is invisible in review and trains people to add more.
   */
  {
    files: [
      'src/infrastructure/llm/**/*.ts',
      'src/infrastructure/speech/**/*.ts',
      'src/infrastructure/image/**/*.ts',
      'src/infrastructure/search/**/*.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Dev tooling. `no-restricted-syntax` is off for the same reason as the block
  // above: these reach fixed vendor endpoints, never a caller-supplied URL, and
  // none of them sit in the request path.
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts', 'eslint.config.js', 'vitest.config.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
