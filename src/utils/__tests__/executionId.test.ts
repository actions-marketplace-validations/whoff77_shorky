// src/utils/__tests__/executionId.test.ts
//
// Regression tests for the shared execution-ID resolver (getExecutionId())
// introduced to fix the "split runs" bug: the Playwright reporter process
// and the separate Shorky CLI process must always resolve to the SAME
// runId for a given CI invocation.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getExecutionId, RUN_ID_FILE_NAME } from '../executionId';

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  delete process.env.SHORKY_RUN_ID;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  resetEnv();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorky-execid-'));
});

afterEach(() => {
  resetEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getExecutionId: prioritizes GITHUB_RUN_ID + GITHUB_RUN_ATTEMPT over everything else', () => {
  process.env.GITHUB_RUN_ID = '123456789';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  process.env.SHORKY_RUN_ID = 'should-be-ignored';

  const id = getExecutionId(tmpDir);

  assert.match(id, UUID_RE, 'GITHUB_RUN_ID-derived IDs must be UUID-shaped for shorky-cloud webhook compatibility');
  // No file should have been written for this path — nothing to hand off,
  // GITHUB_RUN_ID is already shared automatically by GitHub Actions.
  assert.equal(fs.existsSync(path.join(tmpDir, RUN_ID_FILE_NAME)), false);
});

test('getExecutionId: is fully deterministic — same GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT always derives the same UUID', () => {
  process.env.GITHUB_RUN_ID = '999';
  process.env.GITHUB_RUN_ATTEMPT = '1';

  const first = getExecutionId(tmpDir);
  const second = getExecutionId(tmpDir);

  assert.equal(first, second, 'the same GitHub run/attempt must always resolve to the same runId across independent calls (i.e. across processes)');
});

test('getExecutionId: different GITHUB_RUN_ATTEMPT values derive different UUIDs (distinct retries)', () => {
  process.env.GITHUB_RUN_ID = '999';

  process.env.GITHUB_RUN_ATTEMPT = '1';
  const attempt1 = getExecutionId(tmpDir);

  process.env.GITHUB_RUN_ATTEMPT = '2';
  const attempt2 = getExecutionId(tmpDir);

  assert.notEqual(attempt1, attempt2);
});

test('getExecutionId: falls back to SHORKY_RUN_ID when GITHUB_RUN_ID is absent', () => {
  process.env.SHORKY_RUN_ID = 'explicit-override-id';

  const id = getExecutionId(tmpDir);

  assert.equal(id, 'explicit-override-id');
  assert.equal(fs.existsSync(path.join(tmpDir, RUN_ID_FILE_NAME)), false);
});

test('getExecutionId: mints and PERSISTS a fresh ID when neither env var is set, so a second call reuses it', () => {
  const first = getExecutionId(tmpDir);

  assert.ok(first.length > 0);
  const filePath = path.join(tmpDir, RUN_ID_FILE_NAME);
  assert.equal(fs.existsSync(filePath), true, 'the minted ID must be persisted for cross-process handoff');
  assert.equal(fs.readFileSync(filePath, 'utf-8').trim(), first);

  // Simulate a SEPARATE process (e.g. the Shorky CLI step) calling
  // getExecutionId() afterwards with no env vars set — it must read back
  // the exact same ID from the file rather than minting a new one.
  const second = getExecutionId(tmpDir);
  assert.equal(second, first);
});

test('getExecutionId: reuses an existing handoff file written by a prior call/process', () => {
  const filePath = path.join(tmpDir, RUN_ID_FILE_NAME);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(filePath, 'pre-existing-run-id', 'utf-8');

  const id = getExecutionId(tmpDir);

  assert.equal(id, 'pre-existing-run-id');
});
