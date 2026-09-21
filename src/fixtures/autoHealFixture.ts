import { test as baseTest, Page, expect } from '@playwright/test';
import { assertVisual } from '../utils/healingEngine';
import { assertVisualBaseline, VisualDiffOptions } from '../utils/visual-diff';
import { getTokensUsedThisTest, resetTokensUsedThisTest } from '../utils/tokenUsage';

/**
 * Attachment name used to bridge LLM token usage from the worker process
 * (where fixtures/test bodies run and OpenAI calls actually happen — see
 * `healingEngine.ts`'s `recordTokenUsage()`) to the main process reporter
 * (`cloudReporter.ts`, which runs in a separate process and has no direct
 * access to worker-local state). `cloudReporter.ts`'s `onTestEnd()` looks
 * for an attachment with this exact name.
 */
export const SHORKY_TOKENS_ATTACHMENT_NAME = 'shorky-tokens-used';

export type AutoHealFixtures = {
  autoHealPage: {
    page: Page;
    clickAndHeal: (selector: string) => Promise<void>;
    assertVisual: (expectation: string) => Promise<void>;
    assertVisualBaseline: (snapshotName: string, options?: VisualDiffOptions) => Promise<void>;
  };
};

export const test = baseTest.extend<AutoHealFixtures>({
  autoHealPage: async ({ page }, use, testInfo) => {
    // Reset the per-test token counter at fixture setup so tokens consumed
    // by a *previous* test sharing this worker process never bleed into
    // the current test's reported usage (see tokenUsage.ts).
    resetTokensUsedThisTest();

    // Strict pass-through: no cache lookup, no fallback self-healing. Tests
    // must fail using standard Playwright behavior (a normal timeout error)
    // so `fixTrace.ts` can permanently repair the underlying source code
    // instead of this fixture silently papering over a stale selector at
    // runtime.
    const clickAndHeal = async (selector: string) => {
      await page.click(selector);
    };

    const runVisualCheck = async (expectation: string) => {
      console.log(`👁️ [Shorky Vision] Auditing visual layout: "${expectation}"...`);
      const result = await assertVisual(page, expectation);

      if (!result.passed) {
        console.error(`❌ [Shorky Vision Failed] ${result.reason}`);
        throw new Error(`Visual assertion failed: ${result.reason}`);
      } else {
        console.log(`✅ [Shorky Vision Passed] ${result.reason}`);
      }
    };

    const runVisualBaseline = async (snapshotName: string, options?: VisualDiffOptions) => {
      await assertVisualBaseline(page, snapshotName, options ?? {});
    };

    await use({
      page,
      clickAndHeal,
      assertVisual: runVisualCheck,
      assertVisualBaseline: runVisualBaseline,
    });

    // Fixture teardown (runs after the test body completes, but while
    // `testInfo` is still attachable): snapshot the tokens consumed by any
    // self-healing/vision calls made during this test and attach them to
    // the test result so `cloudReporter.ts` (running in the main process)
    // can read them back out in `onTestEnd()`.
    const tokensUsed = getTokensUsedThisTest();
    if (tokensUsed > 0) {
      await testInfo.attach(SHORKY_TOKENS_ATTACHMENT_NAME, {
        body: String(tokensUsed),
        contentType: 'text/plain',
      });
    }
  },
});

export { expect };