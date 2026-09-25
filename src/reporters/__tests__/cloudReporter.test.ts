// src/reporters/__tests__/cloudReporter.test.ts
//
// Regression tests for the retry-duplication bug in ShorkyCloudReporter's
// onTestEnd(): Playwright invokes onTestEnd() once per ATTEMPT (initial +
// every retry), so a test retried N times must still only ever produce
// ONE testItems entry / ONE runData increment — not N.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import ShorkyCloudReporter from '../cloudReporter';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.SHORKY_CLOUD_API_KEY = 'test-api-key';
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
});

/** Minimal TestResult stub — only the fields ShorkyCloudReporter actually reads. */
function makeResult(overrides: Partial<any> = {}): any {
  return {
    status: 'failed',
    error: { message: 'Timeout exceeded' },
    attachments: [],
    ...overrides,
  };
}

/** Minimal TestCase stub whose `results` array + `outcome()` mimic Playwright's real semantics. */
function makeTestCase(results: any[], outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped'): any {
  return {
    title: 'user should be able to log in',
    results,
    outcome: () => outcome,
  };
}

// Reaches into the reporter's private fields for assertions — acceptable
// in a test file exercising internal accumulation state directly.
function getInternals(reporter: ShorkyCloudReporter): { testItems: any[]; runData: { passed: number; failed: number } } {
  return reporter as any;
}

test('onTestEnd: a test retried 3 times (all failed/timedOut) emits exactly ONE testItems entry and increments failed exactly once', () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'timedOut', error: { message: 'attempt 1 timed out' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'attempt 2 timed out' } });
  const attempt3 = makeResult({ status: 'timedOut', error: { message: 'attempt 3 (final) timed out' } });

  const results = [attempt1, attempt2, attempt3];
  const test1 = makeTestCase(results, 'unexpected');

  // Simulate Playwright invoking onTestEnd() once per attempt, in order —
  // exactly as the real runner does (see playwright/lib/runner/index.js's
  // `_onTestEnd()`).
  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);
  reporter.onTestEnd(test1, attempt3);

  const { testItems, runData } = getInternals(reporter);

  assert.equal(testItems.length, 1, 'exactly one telemetry record must be emitted for this test, regardless of retry count');
  assert.equal(runData.failed, 1, 'runData.failed must only be incremented once per test, not once per attempt');
  assert.equal(runData.passed, 0);
  assert.equal(testItems[0].status, 'failed');
});

test('onTestEnd: combines error messages from every failed attempt into the single emitted record', () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'timedOut', error: { message: 'attempt 1 timed out' } });
  const attempt2 = makeResult({ status: 'timedOut', error: { message: 'attempt 2 (final) timed out' } });
  const results = [attempt1, attempt2];
  const test1 = makeTestCase(results, 'unexpected');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);

  const { testItems } = getInternals(reporter);
  assert.equal(testItems.length, 1);
  assert.match(testItems[0].error, /attempt 1 timed out/);
  assert.match(testItems[0].error, /attempt 2 \(final\) timed out/);
});

test('onTestEnd: a flaky test (failed once, then passed on retry) is reported as PASSED exactly once', () => {
  const reporter = new ShorkyCloudReporter();

  const attempt1 = makeResult({ status: 'failed', error: { message: 'flaky failure' } });
  const attempt2 = makeResult({ status: 'passed', error: undefined });
  const results = [attempt1, attempt2];
  const test1 = makeTestCase(results, 'flaky');

  reporter.onTestEnd(test1, attempt1);
  reporter.onTestEnd(test1, attempt2);

  const { testItems, runData } = getInternals(reporter);
  assert.equal(testItems.length, 1);
  assert.equal(testItems[0].status, 'passed');
  assert.equal(runData.passed, 1);
  assert.equal(runData.failed, 0);
});

test('onTestEnd: a single-attempt (no retries) passing test still emits exactly one record', () => {
  const reporter = new ShorkyCloudReporter();

  const onlyAttempt = makeResult({ status: 'passed', error: undefined });
  const test1 = makeTestCase([onlyAttempt], 'expected');

  reporter.onTestEnd(test1, onlyAttempt);

  const { testItems, runData } = getInternals(reporter);
  assert.equal(testItems.length, 1);
  assert.equal(testItems[0].status, 'passed');
  assert.equal(runData.passed, 1);
});

test('onTestEnd: does nothing when no API key is configured', () => {
  delete process.env.SHORKY_CLOUD_API_KEY;
  const reporter = new ShorkyCloudReporter();

  const onlyAttempt = makeResult({ status: 'failed' });
  const test1 = makeTestCase([onlyAttempt], 'unexpected');

  reporter.onTestEnd(test1, onlyAttempt);

  const { testItems } = getInternals(reporter);
  assert.equal(testItems.length, 0);
});
