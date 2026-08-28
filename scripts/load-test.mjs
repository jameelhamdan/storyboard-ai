#!/usr/bin/env node
/**
 * Load test for the generation service.
 *
 * Submits N jobs concurrently, polls each to completion, and reports the metrics
 * the brief's acceptance criteria actually ask about: completion rate, per-job
 * wall time, whether anything was rejected rather than queued, and whether jobs
 * interfered with each other.
 *
 * No dependencies — Node 20+ only.
 *
 *   node scripts/load-test.mjs --jobs 3
 *   node scripts/load-test.mjs --jobs 20 --base http://localhost:3000
 *   node scripts/load-test.mjs --jobs 5 --input ./test/corpus/lecture.pdf
 *
 * Run with --jobs 1 first to establish the single-job baseline; the under-load
 * ceiling only means something relative to that number.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

// ---------------------------------------------------------------- arguments

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = {
  baseUrl: arg('base', 'http://localhost:3000'),
  jobCount: Number(arg('jobs', '3')),
  inputPath: arg('input', null),
  sourceUrl: arg('url', 'https://en.wikipedia.org/wiki/Cellular_respiration'),
  outputLanguage: arg('language', 'en'),
  preset: arg('preset', 'standard'),
  pollIntervalMs: Number(arg('poll', '3000')),
  timeoutMs: Number(arg('timeout', String(20 * 60 * 1000))),
};

// The brief's two timing commitments, in milliseconds.
const SINGLE_JOB_CEILING_MS = 5 * 60 * 1000;
const UNDER_LOAD_CEILING_MS = 8 * 60 * 1000;

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (ms) => (ms / 1000).toFixed(1);

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((p / 100) * sortedValues.length) - 1,
  );
  return sortedValues[index];
}

// ---------------------------------------------------------------- one job

async function submitJob(index, fileBuffer) {
  const form = new FormData();
  form.append('output_language', config.outputLanguage);
  form.append('quality_preset', config.preset);

  if (fileBuffer) {
    form.append('files', new Blob([fileBuffer]), basename(config.inputPath));
  } else {
    form.append('urls', config.sourceUrl);
  }

  const response = await fetch(`${config.baseUrl}/v1/generate`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    // A rejection under load is itself a finding: the brief requires excess
    // requests to be queued, never turned away.
    const body = await response.text().catch(() => '');
    throw new Error(`submit rejected with HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const { job_id: jobId } = await response.json();
  if (!jobId) throw new Error('submit succeeded but returned no job_id');
  return jobId;
}

async function pollToCompletion(jobId, startedAt) {
  let lastProgress = -1;

  while (Date.now() - startedAt < config.timeoutMs) {
    await sleep(config.pollIntervalMs);

    const response = await fetch(`${config.baseUrl}/v1/status/${jobId}`);
    if (!response.ok) throw new Error(`status returned HTTP ${response.status}`);

    const status = await response.json();

    if (status.progress_percent !== lastProgress) {
      lastProgress = status.progress_percent;
    }

    if (status.status === 'completed') return status;
    if (status.status === 'failed') {
      throw new Error(`job failed: ${status.error?.code ?? 'no error code'} — ${status.error?.message ?? ''}`);
    }
    if (status.status === 'cancelled') throw new Error('job was cancelled');
  }

  throw new Error(`timed out after ${seconds(config.timeoutMs)}s`);
}

async function runJob(index, fileBuffer) {
  const startedAt = Date.now();
  try {
    const jobId = await submitJob(index, fileBuffer);
    const submitMs = Date.now() - startedAt;
    const result = await pollToCompletion(jobId, startedAt);

    return {
      index,
      jobId,
      ok: true,
      submitMs,
      totalMs: Date.now() - startedAt,
      videoUrl: result.video_url,
      subtitleUrl: result.subtitle_url,
      durationSeconds: result.duration_seconds,
      costUsd: result.cost?.total_usd ?? null,
    };
  } catch (error) {
    return {
      index,
      ok: false,
      totalMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

// ---------------------------------------------------------------- report

function report(results, wallMs) {
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const durations = succeeded.map((r) => r.totalMs).sort((a, b) => a - b);
  const ceiling = config.jobCount === 1 ? SINGLE_JOB_CEILING_MS : UNDER_LOAD_CEILING_MS;

  console.log('\n' + '='.repeat(64));
  console.log(`  ${config.jobCount} concurrent job(s) — ${config.preset} preset`);
  console.log('='.repeat(64));

  console.log(`\n  Completed        ${succeeded.length}/${results.length}`);
  console.log(`  Wall clock       ${seconds(wallMs)}s`);

  if (durations.length > 0) {
    console.log(`  Fastest job      ${seconds(durations[0])}s`);
    console.log(`  Median (p50)     ${seconds(percentile(durations, 50))}s`);
    console.log(`  p95              ${seconds(percentile(durations, 95))}s`);
    console.log(`  Slowest job      ${seconds(durations[durations.length - 1])}s`);
    console.log(`  Throughput       ${(succeeded.length / (wallMs / 1000 / 60)).toFixed(2)} jobs/min`);
  }

  const submitTimes = succeeded.map((r) => r.submitMs);
  if (submitTimes.length > 0) {
    const slowestSubmit = Math.max(...submitTimes);
    console.log(`  Slowest POST     ${seconds(slowestSubmit)}s ${slowestSubmit > 2000 ? '(API is blocking — it should return immediately)' : ''}`);
  }

  // Acceptance checks.
  console.log('\n  Checks');
  const over = durations.filter((d) => d > ceiling);
  const label = config.jobCount === 1 ? '5 min (single job)' : '8 min (under load)';
  check(failed.length === 0, `all jobs completed without failure`);
  check(over.length === 0, `no job exceeded ${label}${over.length ? ` — ${over.length} did` : ''}`);
  check(
    !failed.some((f) => /rejected with HTTP 4|rejected with HTTP 5/.test(f.error)),
    'no request was rejected (excess load must queue, not 4xx/5xx)',
  );

  const urls = succeeded.map((r) => r.videoUrl).filter(Boolean);
  check(
    new Set(urls).size === urls.length,
    'every job produced a distinct video URL (no cross-job interference)',
  );

  const costs = succeeded.map((r) => r.costUsd).filter((c) => c != null);
  if (costs.length > 0) {
    const totalCost = costs.reduce((a, b) => a + b, 0);
    const totalMinutes = succeeded.reduce((a, r) => a + (r.durationSeconds ?? 0), 0) / 60;
    console.log(`\n  Cost             $${totalCost.toFixed(3)} total`);
    if (totalMinutes > 0) {
      const perMinute = totalCost / totalMinutes;
      console.log(`  Per video-min    $${perMinute.toFixed(4)} ${perMinute <= 0.10 ? '(within target)' : '(OVER $0.10 target)'}`);
    }
  }

  if (failed.length > 0) {
    console.log('\n  Failures');
    for (const f of failed) {
      console.log(`    job ${f.index}: ${f.error}`);
    }
  }

  console.log('');
  return failed.length === 0 && over.length === 0;
}

function check(passed, description) {
  console.log(`    ${passed ? 'PASS' : 'FAIL'}  ${description}`);
}

// ---------------------------------------------------------------- main

async function main() {
  const fileBuffer = config.inputPath ? await readFile(config.inputPath) : null;

  console.log(`Target      ${config.baseUrl}`);
  console.log(`Input       ${config.inputPath ?? config.sourceUrl}`);
  console.log(`Submitting  ${config.jobCount} job(s) concurrently...`);

  // Health check first — a connection refused here is much clearer than 20
  // simultaneous submit failures.
  try {
    const health = await fetch(`${config.baseUrl}/v1/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (error) {
    console.error(`\nCannot reach ${config.baseUrl}/v1/health — is the service running?`);
    console.error(`  ${error.message}\n`);
    process.exit(2);
  }

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: config.jobCount }, (_, i) => runJob(i, fileBuffer)),
  );
  const wallMs = Date.now() - startedAt;

  process.exit(report(results, wallMs) ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nload test aborted: ${error.message}\n`);
  process.exit(2);
});
