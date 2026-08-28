/**
 * A complete environment for tests.
 *
 * Tests must not depend on a developer's `.env` — it is gitignored, so a suite
 * that reads it passes locally and fails in CI for reasons that look unrelated
 * to the change. Everything the config loader requires is stated here.
 */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CONFIG_DIR: 'config',
    REDIS_URL: 'redis://127.0.0.1:6379',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: '.workspace/test-artifacts',
    STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:3000/artifacts',
    WORKSPACE_DIR: '.workspace/test-jobs',

    // Voice ids live in .env by design (brief §4); the loader requires all four.
    VOICE_EN_FEMALE_1: 'test-en-female',
    VOICE_EN_MALE_1: 'test-en-male',
    VOICE_ES_FEMALE_1: 'test-es-female',
    VOICE_ES_MALE_1: 'test-es-male',

    ...overrides,
  };
}
