import { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';
import { getShorkyCloudApiKey, getShorkyCloudTelemetryUrl, isShorkyCloudEnabled, logDashboardCallToAction } from '../config/shorkyCloud';
import { SHORKY_TOKENS_ATTACHMENT_NAME } from '../fixtures/autoHealFixture';
import { resolveRepositoryName } from '../utils/gitContext';
import { runPreflightCheck } from '../cli/preflight';

interface TestRunItem {
  title: string;
  status: 'passed' | 'failed' | 'healed';
  error?: string;
  /** LLM tokens consumed self-healing/asserting-vision during this test, extracted from the `SHORKY_TOKENS_ATTACHMENT_NAME` attachment (see `autoHealFixture.ts`). */
  tokensUsed: number;
}

/**
 * Extracts the LLM token count `autoHealFixture.ts` attached to this test
 * result (see `SHORKY_TOKENS_ATTACHMENT_NAME`), if any. Attachments cross
 * the worker-process -> main-process boundary as plain buffers/strings, so
 * this parses the attachment body back into a number, defensively falling
 * back to 0 for any malformed/missing attachment rather than throwing.
 */
function extractTokensUsed(result: TestResult): number {
  const attachment = result.attachments.find((a) => a.name === SHORKY_TOKENS_ATTACHMENT_NAME);
  if (!attachment) return 0;

  const raw = attachment.body ? attachment.body.toString('utf-8') : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default class ShorkyCloudReporter implements Reporter {
  private apiEndpoint: string;
  private apiKey: string;
  private testItems: TestRunItem[] = [];
  private runData: {
    passed: number;
    failed: number;
  };

  constructor() {
    this.apiEndpoint = getShorkyCloudTelemetryUrl();
    this.apiKey = getShorkyCloudApiKey();
    this.runData = {
      passed: 0,
      failed: 0,
    };
  }

  onBegin(config: FullConfig, suite: Suite) {
    if (!this.apiKey) {
      console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not found. Skipping cloud reporting.');
      logDashboardCallToAction();
      return;
    }
    console.log('🚀 [Shorky] Initializing Shorky Cloud reporting run...');
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.apiKey) return;

    let testStatus: 'passed' | 'failed' | 'healed' = 'passed';

    if (result.status === 'passed') {
      this.runData.passed++;
      testStatus = 'passed';
    } else if (result.status === 'failed' || result.status === 'timedOut') {
      this.runData.failed++;
      testStatus = 'failed';
    }

    const errorMessage = result.error?.message || result.error?.stack;
    const tokensUsed = extractTokensUsed(result);

    this.testItems.push({
      title: test.title,
      status: testStatus,
      error: errorMessage,
      tokensUsed,
    });
  }

  async onEnd(result: FullResult) {
    const cloudUrl = getShorkyCloudTelemetryUrl();

    // Skip attempting transmission entirely if cloud is explicitly disabled
    if (!isShorkyCloudEnabled()) {
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
      const preflight = await runPreflightCheck();
      if (preflight.acceptsTelemetry === false) {
        console.log(
          `ℹ️ [Shorky Cloud] Skipping telemetry transmission: ${preflight.message || 'free tier cloud storage quota reached.'}`,
        );
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
      const [repoOwner, repoName] = resolveRepositoryName().split('/');

      // Construct the flattened payload matching shorky-cloud's Zod schema
      const telemetryPayload = {
        projectName: process.env.SHORKY_PROJECT_NAME || 'shorky',
        repoOwner,
        repoName,
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
          'x-shorky-api-key': getShorkyCloudApiKey(),
        },
        body: JSON.stringify(telemetryPayload),
        // Set a short timeout so offline runs don't hang execution
        signal: AbortSignal.timeout(3000), 
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('⚠️ [Shorky Cloud] Backend responded with status:', response.status, JSON.stringify(errorData, null, 2));
      } else {
        console.log('✅ [Shorky Cloud] Telemetry successfully transmitted.');
        logDashboardCallToAction();
      }
    } catch (error: any) {
      // Gracefully log offline status without throwing an unhandled stack trace
      if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
        console.warn('ℹ️ [Shorky Cloud] Cloud server unavailable. Continuing offline execution.');
      } else {
        console.warn('⚠️ [Shorky Cloud] Telemetry warning:', error?.message || error);
      }
    }
  }
}