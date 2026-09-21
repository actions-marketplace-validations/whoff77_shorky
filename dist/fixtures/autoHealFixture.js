"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expect = exports.test = exports.SHORKY_TOKENS_ATTACHMENT_NAME = void 0;
const test_1 = require("@playwright/test");
Object.defineProperty(exports, "expect", { enumerable: true, get: function () { return test_1.expect; } });
const healingEngine_1 = require("../utils/healingEngine");
const visual_diff_1 = require("../utils/visual-diff");
const tokenUsage_1 = require("../utils/tokenUsage");
/**
 * Attachment name used to bridge LLM token usage from the worker process
 * (where fixtures/test bodies run and OpenAI calls actually happen — see
 * `healingEngine.ts`'s `recordTokenUsage()`) to the main process reporter
 * (`cloudReporter.ts`, which runs in a separate process and has no direct
 * access to worker-local state). `cloudReporter.ts`'s `onTestEnd()` looks
 * for an attachment with this exact name.
 */
exports.SHORKY_TOKENS_ATTACHMENT_NAME = 'shorky-tokens-used';
exports.test = test_1.test.extend({
    autoHealPage: async ({ page }, use, testInfo) => {
        // Reset the per-test token counter at fixture setup so tokens consumed
        // by a *previous* test sharing this worker process never bleed into
        // the current test's reported usage (see tokenUsage.ts).
        (0, tokenUsage_1.resetTokensUsedThisTest)();
        const runVisualCheck = async (expectation) => {
            console.log(`👁️ [Shorky Vision] Auditing visual layout: "${expectation}"...`);
            const result = await (0, healingEngine_1.assertVisual)(page, expectation);
            if (!result.passed) {
                console.error(`❌ [Shorky Vision Failed] ${result.reason}`);
                throw new Error(`Visual assertion failed: ${result.reason}`);
            }
            else {
                console.log(`✅ [Shorky Vision Passed] ${result.reason}`);
            }
        };
        const runVisualBaseline = async (snapshotName, options) => {
            await (0, visual_diff_1.assertVisualBaseline)(page, snapshotName, options ?? {});
        };
        await use({
            page,
            assertVisual: runVisualCheck,
            assertVisualBaseline: runVisualBaseline,
        });
        // Fixture teardown (runs after the test body completes, but while
        // `testInfo` is still attachable): snapshot the tokens consumed by any
        // self-healing/vision calls made during this test and attach them to
        // the test result so `cloudReporter.ts` (running in the main process)
        // can read them back out in `onTestEnd()`.
        const tokensUsed = (0, tokenUsage_1.getTokensUsedThisTest)();
        if (tokensUsed > 0) {
            await testInfo.attach(exports.SHORKY_TOKENS_ATTACHMENT_NAME, {
                body: String(tokensUsed),
                contentType: 'text/plain',
            });
        }
    },
});
