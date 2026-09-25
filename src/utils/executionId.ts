// src/utils/executionId.ts
//
// Single source of truth for resolving the ONE shared execution/run
// identifier that must be consistent across every process involved in a
// single CI invocation: the Playwright test process (`cloudReporter.ts`,
// running in the main reporter process) and the separate Shorky CLI
// process (`fixTrace.ts`'s `runReportFix()`/`runOfflineFix()`, which runs
// as its own GitHub Actions step AFTER the Playwright process has already
// exited).
//
// Previously, each of those two processes independently fell back to its
// own `randomUUID()` whenever no shared identifier was available, which
// produced two DIFFERENT UUIDs for the same CI run — causing shorky-cloud
// to show the failing-test telemetry and the auto-healing PR/webhook
// dispatch as two unrelated "runs" on the dashboard instead of one.
//
// Resolution order (first match wins):
//   1. `GITHUB_RUN_ID` (+ `GITHUB_RUN_ATTEMPT` when present) — GitHub
//      Actions sets `GITHUB_RUN_ID` identically for EVERY step/process in a
//      given workflow run, with zero coordination required between
//      processes. This is strongly preferred: it's a real, numeric,
//      human-traceable identifier (matches the "GitHub Run ID" the user
//      sees in the Actions UI) rather than an opaque UUID, and requires no
//      file/env handoff at all.
//   2. `SHORKY_RUN_ID` env var — an explicit override/orchestration hook
//      (e.g. a consuming project's `global-setup.ts` that already minted
//      one and exported it to `$GITHUB_ENV`), preserved for backward
//      compatibility and non-GitHub-Actions CI providers.
//   3. `<runIdFileDir>/.shorky-run-id` — a file-based deterministic
//      handoff for the (increasingly rare, non-GitHub-Actions) case where
//      neither of the above is available: whichever process calls
//      `getExecutionId()` FIRST mints a fresh UUID and persists it here;
//      every subsequent call (including from a totally separate process)
//      reads the same file and reuses that exact ID instead of minting its
//      own.
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

/** Default location (relative to cwd) for the deterministic run-ID handoff file. */
export const DEFAULT_RUN_ID_FILE_DIR = 'test-results';

/** The fixed filename used for the run-ID handoff file within `runIdFileDir`. */
export const RUN_ID_FILE_NAME = '.shorky-run-id';

/**
 * Deterministically derives a syntactically-valid UUID (v4-shaped, per
 * RFC 4122 section 4.4) from an arbitrary input string via SHA-256 hashing.
 * The SAME input always produces the SAME output, which is exactly what's
 * needed here: shorky-cloud's `/api/webhook` validates `runId` with
 * `z.string().uuid()` and stores it directly as `testRuns.id` (a `uuid`
 * column), so a raw `"<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>"` string (e.g.
 * `"3456789-1"`) would fail that validation. Hashing it into UUID shape
 * keeps GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT as the deterministic, zero-
 * coordination source of truth while remaining a drop-in, schema-
 * compatible replacement for the previous `randomUUID()` fallback.
 */
function deriveDeterministicUuid(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  const bytes = hash.slice(0, 32);
  return [
    bytes.slice(0, 8),
    bytes.slice(8, 12),
    // Version 4 nibble, per RFC 4122.
    `4${bytes.slice(13, 16)}`,
    // Variant bits (10xx), per RFC 4122.
    `${((parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16)}${bytes.slice(17, 20)}`,
    bytes.slice(20, 32),
  ].join('-');
}

/**
 * Resolves (and, if necessary, mints + persists) the single shared
 * execution identifier for this CI run. Safe to call from multiple
 * independent processes (e.g. the Playwright reporter AND the separate
 * Shorky CLI step) — every caller ends up with the exact same value.
 *
 * @param runIdFileDir Directory the `.shorky-run-id` handoff file lives in
 *   (or should be written to) when falling back to step 3 above. Defaults
 *   to `test-results` (the same directory Playwright's JSON reporter/trace
 *   output already lives in), but callers that know the report's actual
 *   directory (e.g. `fixTrace.ts`, given `--report <path>`) should pass it
 *   explicitly so both processes agree on the same file location.
 */
export function getExecutionId(runIdFileDir: string = DEFAULT_RUN_ID_FILE_DIR): string {
  // 1. GITHUB_RUN_ID (+ GITHUB_RUN_ATTEMPT) — numeric, deterministic, and
  // automatically shared across every step/process in the same workflow
  // run by GitHub Actions itself. No file/env handoff needed.
  if (process.env.GITHUB_RUN_ID) {
    const rawId = process.env.GITHUB_RUN_ATTEMPT
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      : process.env.GITHUB_RUN_ID;
    // Hashed into UUID shape (see deriveDeterministicUuid) so it stays
    // compatible with shorky-cloud's `runId: z.string().uuid()` webhook
    // validation and its `uuid` DB column, while remaining fully
    // deterministic — every process in this same workflow run derives the
    // exact same UUID from the exact same GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT.
    const runId = deriveDeterministicUuid(rawId);
    console.log(`🆔 [Diagnostic] Resolved execution ID "${runId}" (deterministically derived from GITHUB_RUN_ID${process.env.GITHUB_RUN_ATTEMPT ? '/GITHUB_RUN_ATTEMPT' : ''}="${rawId}").`);
    return runId;
  }

  // 2. SHORKY_RUN_ID — explicit override / orchestration hook.
  if (process.env.SHORKY_RUN_ID) {
    console.log(`🆔 [Diagnostic] Resolved execution ID "${process.env.SHORKY_RUN_ID}" from SHORKY_RUN_ID env var.`);
    return process.env.SHORKY_RUN_ID;
  }

  // 3. Deterministic file-based handoff: read an already-written ID if
  // present, otherwise mint one and persist it for the next reader.
  const runIdFilePath = path.join(path.resolve(runIdFileDir), RUN_ID_FILE_NAME);

  if (fs.existsSync(runIdFilePath)) {
    const fileRunId = fs.readFileSync(runIdFilePath, 'utf-8').trim();
    if (fileRunId) {
      console.log(`🆔 [Diagnostic] Resolved execution ID "${fileRunId}" from ${runIdFilePath} (written by an earlier process in this run).`);
      return fileRunId;
    }
  }

  const generatedRunId = randomUUID();
  try {
    fs.mkdirSync(path.dirname(runIdFilePath), { recursive: true });
    fs.writeFileSync(runIdFilePath, generatedRunId, 'utf-8');
    console.log(`🆔 [Diagnostic] No GITHUB_RUN_ID/SHORKY_RUN_ID/${RUN_ID_FILE_NAME} found — minted execution ID "${generatedRunId}" and persisted it to ${runIdFilePath} for any other process in this run to reuse.`);
  } catch (err: any) {
    console.warn(`⚠️ [Diagnostic] Minted execution ID "${generatedRunId}" but failed to persist it to ${runIdFilePath} for cross-process handoff:`, err?.message || err);
  }
  return generatedRunId;
}
