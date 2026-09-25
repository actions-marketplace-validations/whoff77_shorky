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
    testItems = [];
    runData;
    constructor() {
        this.apiEndpoint = (0, shorkyCloud_1.getShorkyCloudTelemetryUrl)();
        this.apiKey = (0, shorkyCloud_1.getShorkyCloudApiKey)();
        this.runData = {
            passed: 0,
            failed: 0,
        };
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
        // Playwright calls onTestEnd() once per ATTEMPT — the initial run plus
        // every retry (see @playwright/test's runner, which invokes
        // `reporter.onTestEnd?.(test, result)` synchronously after each
        // attempt finishes) — not once per test. With retries enabled (e.g.
        // `retries: 2` on CI), a single test that times out 3 times previously
        // caused THREE separate pushes here, tripling both `runData.failed`
        // and the number of `tests[]` entries sent to shorky-cloud for what is
        // really one test.
        //
        // `test.results` accumulates every attempt's TestResult in order, and
        // by the time this callback fires for a given attempt, that attempt's
        // result is always the LAST entry in `test.results` (Playwright
        // appends to it before invoking the reporter). So comparing the
        // current `result` against `test.results[test.results.length - 1]`
        // reliably detects "this is the final attempt for this test" — the
        // one whose outcome should actually be reported — and skips emitting
        // anything for earlier (intermediate, retried) attempts.
        const isFinalAttempt = test.results[test.results.length - 1] === result;
        if (!isFinalAttempt) {
            return;
        }
        let testStatus = 'passed';
        // `test.outcome()` reflects Playwright's own final verdict across all
        // retries ('flaky' when a later attempt passed after earlier
        // failures, 'unexpected' when every attempt ultimately failed) —
        // preferred here over inspecting `result.status` in isolation so a
        // flaky-but-ultimately-passing test is correctly reported as passed
        // rather than failed.
        const outcome = test.outcome();
        if (outcome === 'expected' || outcome === 'flaky') {
            this.runData.passed++;
            testStatus = 'passed';
        }
        else if (outcome === 'unexpected') {
            this.runData.failed++;
            testStatus = 'failed';
        }
        // outcome() === 'skipped' intentionally increments neither counter and
        // leaves testStatus at its 'passed' default, matching this reporter's
        // previous (pre-dedup) behavior for skipped/interrupted results.
        // Combine the error message from EVERY failed attempt (not just the
        // final one) so the telemetry record still reflects the full retry
        // history, even though only one record is now emitted per test.
        const failedAttempts = test.results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
        const errorMessage = failedAttempts.length > 1
            ? failedAttempts
                .map((r, i) => `[Attempt ${i + 1}/${failedAttempts.length}] ${r.error?.message || r.error?.stack || 'Unknown error'}`)
                .join('\n')
            : result.error?.message || result.error?.stack;
        // Tokens are attached per-attempt (see autoHealFixture.ts); sum across
        // every attempt so retried self-healing spend is never undercounted
        // now that only one telemetry record is emitted per test.
        const tokensUsed = test.results.reduce((sum, r) => sum + extractTokensUsed(r), 0);
        this.testItems.push({
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
            const passedCount = this.runData.passed;
            const failedCount = this.runData.failed;
            const durationMs = Math.round(result.duration ?? 0);
            // Sum of every test's tokensUsed (captured from OpenAI response.usage
            // during self-healing/vision calls — see tokenUsage.ts and
            // autoHealFixture.ts). Reported both per-test and as a run-level
            // total below; shorky-cloud's /api/v1/telemetry uses the run-level
            // total when present, atomically incrementing that project's
            // tokensUsedThisMonth for the /api/v1/governance/preflight budget guard.
            const totalTokensUsed = this.testItems.reduce((sum, item) => sum + item.tokensUsed, 0);
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
                tests: this.testItems.map((item) => ({
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
