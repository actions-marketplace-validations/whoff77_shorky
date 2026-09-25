"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const shorkyCloud_1 = require("../config/shorkyCloud");
const autoHealFixture_1 = require("../fixtures/autoHealFixture");
const gitContext_1 = require("../utils/gitContext");
const preflight_1 = require("../cli/preflight");
const executionId_1 = require("../utils/executionId");
/**
 * Extracts the LLM token count `autoHealFixture.ts` attached to this test
 * result (see `SHORKY_TOKENS_ATTACHMENT_NAME`), if any. Attachments cross
 * the worker-process -> main-process boundary as plain buffers/strings, so
 * this parses the attachment body back into a number, defensively falling
 * back to 0 for any malformed/missing attachment rather than throwing.
 */
function extractTokensUsed(result) {
    const attachment = result.attachments.find((a) => a.name === autoHealFixture_1.SHORKY_TOKENS_ATTACHMENT_NAME);
    if (!attachment)
        return 0;
    const raw = attachment.body ? attachment.body.toString('utf-8') : undefined;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
class ShorkyCloudReporter {
    apiEndpoint;
    apiKey;
    // Accumulates ONE entry per test, keyed by `test.id` (a stable,
    // Playwright-assigned identifier — see TestCase.id — unique within the
    // session, unlike `test.title` which can collide across describe blocks/
    // projects). Playwright invokes `onTestEnd()` once per ATTEMPT — the
    // initial run plus every retry (see @playwright/test's runner, which
    // calls `reporter.onTestEnd?.(test, result)` synchronously after each
    // attempt finishes) — and, critically, `result` is ALREADY the last
    // element of `test.results` at the moment ANY attempt's `onTestEnd`
    // fires (Playwright appends it in `_onTestBegin()`, before the attempt
    // even runs). That means a "is this the final attempt?" check comparing
    // `result` against `test.results[test.results.length - 1]` is always
    // true and never actually filters anything out — the real fix is to
    // never treat any individual `onTestEnd()` call as final. Instead, each
    // call simply OVERWRITES this test's entry in the Map with the latest
    // snapshot; by definition, whatever is in the Map when `onEnd()` finally
    // reads it reflects each test's LAST (i.e. final/terminal) attempt.
    testResultsById = new Map();
    constructor() {
        this.apiEndpoint = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
        this.apiKey = (0, shorkyCloud_1.getShorkyCloudApiKey)();
    }
    onBegin(config, suite) {
        if (!this.apiKey) {
            console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not found. Skipping cloud reporting.');
            (0, shorkyCloud_1.logDashboardCallToAction)();
            return;
        }
        console.log('🚀 [Shorky] Initializing Shorky Cloud reporting run...');
    }
    onTestEnd(test, result) {
        if (!this.apiKey)
            return;
        let testStatus = 'passed';
        // `test.outcome()` reflects Playwright's own final verdict across all
        // retries observed SO FAR ('flaky' once a later attempt passed after
        // earlier failures, 'unexpected' once every attempt so far failed) —
        // preferred over inspecting `result.status` in isolation so a
        // flaky-but-ultimately-passing test is correctly reported as passed
        // rather than failed. Because this entry is overwritten on every
        // attempt and only read back in `onEnd()` after the whole run
        // finishes, whatever `outcome()` reports on the LAST `onTestEnd()`
        // call for this test (i.e. after its final attempt) is authoritative.
        const outcome = test.outcome();
        if (outcome === 'expected' || outcome === 'flaky') {
            testStatus = 'passed';
        }
        else if (outcome === 'unexpected') {
            testStatus = 'failed';
        }
        // outcome() === 'skipped' intentionally leaves testStatus at its
        // 'passed' default, matching this reporter's previous behavior for
        // skipped/interrupted results.
        // Combine the error message from EVERY attempt failed SO FAR (not just
        // this one) so the final overwritten entry reflects the full retry
        // history once the last attempt's onTestEnd() call overwrites it.
        const failedAttempts = test.results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
        const errorMessage = failedAttempts.length > 1
            ? failedAttempts
                .map((r, i) => `[Attempt ${i + 1}/${failedAttempts.length}] ${r.error?.message || r.error?.stack || 'Unknown error'}`)
                .join('\n')
            : result.error?.message || result.error?.stack;
        // Tokens are attached per-attempt (see autoHealFixture.ts); sum across
        // every attempt observed so far so retried self-healing spend is never
        // undercounted once only the final overwritten entry is read back.
        const tokensUsed = test.results.reduce((sum, r) => sum + extractTokensUsed(r), 0);
        // OVERWRITE (never push/append) this test's entry, keyed by its stable
        // `test.id`. A retried test's earlier attempt(s) already wrote an
        // entry here; this attempt's call simply replaces it, so whatever
        // remains in the Map once the whole run ends is each test's single,
        // final-attempt snapshot — never duplicated per retry.
        this.testResultsById.set(test.id, {
            title: test.title,
            status: testStatus,
            error: errorMessage,
            tokensUsed,
        });
    }
    async onEnd(result) {
        const cloudUrl = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
        // Skip attempting transmission entirely if cloud is explicitly disabled
        if (!(0, shorkyCloud_1.isShorkyCloudEnabled)()) {
            console.log('ℹ️ [Shorky Cloud] Telemetry transmission skipped (SHORKY_CLOUD_API_KEY not configured).');
            return;
        }
        try {
            // Governance pre-check: ask shorky-cloud's tier-aware
            // `/api/v1/governance/preflight` whether it will actually accept
            // telemetry before paying the network round-trip to
            // `/api/v1/telemetry`. A free-tier project that has hit its cloud
            // storage quota gets `acceptsTelemetry: false` here — previously
            // the CLI always POSTed the payload anyway and relied on
            // `/api/v1/telemetry`'s own server-side drop behavior (still in
            // place as a safety net), wasting the round-trip. `undefined`
            // (check skipped/failed open, or Pro tier with no storage quota)
            // is treated as "proceed" — only an explicit `false` skips the POST.
            const preflight = await (0, preflight_1.runPreflightCheck)();
            if (preflight.acceptsTelemetry === false) {
                console.log(`ℹ️ [Shorky Cloud] Skipping telemetry transmission: ${preflight.message || 'free tier cloud storage quota reached.'}`);
                return;
            }
            console.log(`📤 [Shorky Cloud] Transmitting run artifacts to ${cloudUrl}...`);
            // Read the accumulated per-test Map back out ONLY here, once the
            // entire run has finished — every test's entry has by now been
            // overwritten down to its single final-attempt snapshot (see
            // onTestEnd()'s doc comment), so `testItems` below is naturally
            // deduplicated with exactly one record per test, and the
            // passed/failed totals computed from it are never inflated by
            // retries.
            const testItems = Array.from(this.testResultsById.values());
            const passedCount = testItems.filter((item) => item.status === 'passed').length;
            const failedCount = testItems.filter((item) => item.status === 'failed').length;
            const durationMs = Math.round(result.duration ?? 0);
            // Sum of every test's tokensUsed (captured from OpenAI response.usage
            // during self-healing/vision calls — see tokenUsage.ts and
            // autoHealFixture.ts). Reported both per-test and as a run-level
            // total below; shorky-cloud's /api/v1/telemetry uses the run-level
            // total when present, atomically incrementing that project's
            // tokensUsedThisMonth for the /api/v1/governance/preflight budget guard.
            const totalTokensUsed = testItems.reduce((sum, item) => sum + item.tokensUsed, 0);
            // Standardized repo identity (GITHUB_REPOSITORY -> local .git/config
            // -> "local/unknown") — see gitContext.ts. Split into repoOwner/repoName
            // and sent in the exact same shape `fixTrace.ts`'s notifyShorkyCloud()
            // sends, so the dashboard shows a consistent repo identity for both
            // the run-level telemetry (this reporter) and the per-fix webhook.
            const [repoOwner, repoName] = (0, gitContext_1.resolveRepositoryName)().split('/');
            // Resolve the SAME shared execution ID `fixTrace.ts`'s
            // notifyShorkyCloud()/notifyShorkyCloudBatch() resolve for this exact
            // CI run (see executionId.ts's getExecutionId()) — prioritizing the
            // numeric GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (deterministically hashed
            // into UUID shape), so this reporter (running in the Playwright test
            // process) and the separate Shorky CLI process (running afterwards,
            // as its own GitHub Actions step) always tag their respective
            // telemetry/webhook dispatches with the identical runId instead of
            // each independently minting its own random UUID.
            const runId = (0, executionId_1.getExecutionId)();
            // Construct the flattened payload matching shorky-cloud's Zod schema
            const telemetryPayload = {
                projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
                repoOwner,
                repoName,
                runId,
                status: failedCount > 0 ? 'failed' : 'passed',
                passedCount,
                failedCount,
                durationMs,
                tokensUsed: totalTokensUsed,
                tests: testItems.map((item) => ({
                    testName: item.title,
                    status: item.status,
                    traceLogs: item.error
                        ? [{
                                step: 1,
                                action: 'test_execution',
                                status: item.status === 'failed' ? 'failed' : 'success',
                                timestamp: new Date().toISOString(),
                                message: item.error,
                            }]
                        : [],
                    selfHealingCount: item.status === 'healed' ? 1 : 0,
                    tokensUsed: item.tokensUsed,
                }))
            };
            const response = await fetch(cloudUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-shorky-api-key': (0, shorkyCloud_1.getShorkyCloudApiKey)(),
                },
                body: JSON.stringify(telemetryPayload),
                // Set a short timeout so offline runs don't hang execution
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('⚠️ [Shorky Cloud] Backend responded with status:', response.status, JSON.stringify(errorData, null, 2));
            }
            else {
                console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
                (0, shorkyCloud_1.logDashboardCallToAction)();
            }
        }
        catch (error) {
            // Gracefully log offline status without throwing an unhandled stack trace
            if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
                console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
            }
            else {
                console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
            }
        }
    }
}
exports.default = ShorkyCloudReporter;
