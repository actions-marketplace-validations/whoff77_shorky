# CLINE.md — shorky

## Ecosystem Overview (Multi-Repo)
This repository is part of the 3-repo Shorky ecosystem.
* **`shorky` (The Engine):** The CLI and composite GitHub Action. Parses Playwright traces and uses an LLM to permanently rewrite broken `.spec.ts` files in place ("fail-and-rewrite"). *Rule: No consumer tests or UI in this repo.*
* **`shorky-cloud` (The SaaS):** The Next.js dashboard, telemetry webhook ingestor, and API governance layer (Stripe, NextAuth, Neon Postgres). *Rule: Does not run tests or fix code; only stores and displays telemetry.*
* **`shorky-test-consumer` (The Proving Ground):** The target project containing actual Playwright tests and the CI pipeline (`shorky-heal.yml`) that triggers the Action. *Rule: Used purely to validate the end-to-end healing loop.*

## Project Overview

`shorky` is an **autonomous agentic SDET (Software Development Engineer in Test) framework**. It bridges AI-driven exploratory testing with deterministic, low-cost Playwright CI suites, using a two-phase architecture:

1. **Exploratory Phase (Record):** A ReAct-style AI agent (OpenAI tool/function calling) drives a live Playwright browser session, inspecting the DOM, interacting with elements, and verifying goals from natural-language instructions.
2. **Deterministic Phase (Replay):** A code synthesis engine (`generator.ts`) converts the recorded agent trace into a clean, static TypeScript Playwright spec (`*.generated.spec.ts`) that runs in CI without any live LLM calls.

It is also distributed as a **composite GitHub Action** (`action.yml`) — "Shorky AI Test Auto-Healer" — that parses a Playwright JSON report after a CI failure, resolves the failing spec + trace.zip, asks an LLM to generate a code fix (or flags a visual regression for human review), applies the fix, and opens/updates a consolidated pull request. It optionally reports telemetry to a companion SaaS, `shorky-cloud`. Before any of that LLM repair logic runs, both the CLI (`shorky run --heal`) and the GitHub Action (`fixTrace.ts`) perform a **pre-flight budget check** (`src/cli/preflight.ts`) against `shorky-cloud`'s `/api/v1/preflight` endpoint — a `402` (inactive subscription) or `429` (monthly token budget exceeded) response aborts the repair loop before any OpenAI call is made and fails the CI job normally.

The `shorky` CLI (`dist/cli/index.js`, source `src/cli/index.ts`) wraps `npx playwright test` with flags for self-healing (`--heal`), AI vision assertions (`--vision`), headed mode, and generate-only mode.

## Core Development Rules
- **Self-Documenting Changes:** Before finishing ANY task that adds/removes a feature, renames or deletes a file, changes a fixture/schema/API contract, bumps a cross-repo version pin, or otherwise changes behavior described below, you MUST update this `CLINE.md` to match — both adding what's new AND deleting/correcting whatever it said before that is now stale, wrong, or extraneous. A stale or contradictory `CLINE.md` costs more tokens on every future task than no doc at all (the agent has to re-discover the truth from source first), so treat pruning outdated content as equally mandatory as adding new content. Skip only genuinely trivial changes (typo fixes, formatting, comments) that don't change any behavior this file documents.

## Tech Stack & Core Tools

- **Language/Runtime:** TypeScript (strict mode), Node.js (CommonJS module output)
- **Test/Automation Engine:** Playwright (`@playwright/test`, `playwright-core`)
- **AI/Agentic Logic:** OpenAI SDK (`openai`) — structured tool/function calling for the ReAct loop and code-fix generation
- **CLI Framework:** `commander`
- **Config:** `dotenv` (loads `.env` at repo root)
- **Visual Regression:** Pixelmatch-based diffing (`src/utils/visual-diff.ts`)
- **GitHub Integration:** REST calls in `src/utils/githubPr.ts` for opening/updating auto-heal PRs
- **Build tool:** `tsc` (TypeScript compiler) — compiles `src/` → `dist/`
- **Dev runner:** `tsx` (run TypeScript directly without compiling, used for CLI dev + the GitHub Action entrypoint)
- **Archive handling:** `unzipper` (reads Playwright `trace.zip` files)
- **No database** in this repo — telemetry persistence lives in the sibling `shorky-cloud` repo.

## Testing

`shorky` has no external test framework dependency — unit/mock tests run on **Node's built-in test runner** (`node:test` + `node:assert/strict`), loaded via the already-installed `tsx` for on-the-fly TypeScript execution. This keeps the dependency footprint at zero.

- **Convention:** unit test files live under `src/**/__tests__/*.test.ts`, colocated with the module they cover (e.g. `src/cli/__tests__/preflight.test.ts` tests `src/cli/preflight.ts`). This directory is excluded from the `tsc` build (see `tsconfig.json`'s `exclude`) so test files never leak into `dist/`, and it's outside Playwright's `testDir: './tests'` so Playwright never tries to execute them as browser specs.
- **Run tests:** `npm test` (runs `node --import tsx --test` against every discovered `__tests__/*.test.ts` file) or `npm run test:watch` for watch mode.
- **Mocking:** use `node:test`'s built-in `mock.method()` to stub `global.fetch` (or other I/O) rather than adding a mocking library — see `src/cli/__tests__/preflight.test.ts` for the established pattern (mock `fetch`, snapshot/restore `process.env` in `beforeEach`/`afterEach`, `mock.restoreAll()` in `afterEach`).
- **Coverage today:** `src/cli/__tests__/preflight.test.ts` covers `runPreflightCheck()`'s full contract — success (`200`), hard-stop failures (`402`/`429`, including malformed-body fallback messages), fail-open behavior (timeout, connection-refused, unexpected `5xx`/`401`), and the skip path (no API key / cloud disabled, asserting `fetch` is never called).

## Key Commands

```bash
# Install dependencies
npm install

# Install Playwright browsers (required once)
npx playwright install --with-deps

# Compile TypeScript src/ -> dist/ (also produces the published CLI bin: dist/cli/index.js)
npm run build

# Run the Shorky CLI directly from source (no compile step) — dev convenience script
npm run shorky           # -> tsx src/cli/index.ts

# Run the CLI's own subcommands (after building, or via tsx)
npx tsx src/cli/index.ts run [test-pattern] --project "Google Chrome" [--heal] [--vision] [--headed] [--generate-only]

# Run Playwright tests directly
npx playwright test --project="Google Chrome"

# Run the offline trace-fix analyzer manually (what action.yml invokes in CI)
npx tsx src/cli/fixTrace.ts --report test-results/report.json
npx tsx src/cli/fixTrace.ts --trace <path/to/trace.zip> --spec <path/to/spec.ts>
```

There is no dedicated `test` or `lint` npm script defined in `package.json`; tests are run via the Playwright CLI as shown above.

### Required environment variables (`.env`)
- `OPENAI_API_KEY` — required for the ReAct agent and LLM-based auto-fix generation.
- `SHORKY_CLOUD_URL` / `SHORKY_CLOUD_API_KEY` — optional; enables the Playwright reporter + webhook + pre-flight budget check integration with `shorky-cloud` (`isShorkyCloudEnabled()` in `src/config/shorkyCloud.ts`). When unset, the pre-flight check (`src/cli/preflight.ts`) is skipped entirely and the LLM repair loop always proceeds (no budget to enforce for unconfigured/local runs).
- `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_REF_NAME` — used by `src/utils/githubPr.ts` / `fixTrace.ts` when opening auto-heal pull requests (typically provided automatically inside GitHub Actions).

## Architecture & Conventions

- **`src/agent/`** — the ReAct agent core.
  - `agentRunner.ts`: the Reason-Act-Observe loop; drives an OpenAI chat-completion tool-calling session against a live Playwright `Page`.
  - `tools.ts`: structured tool definitions the agent can call (`navigate`, `inspectDOM`, `fillInput`, `clickElement`, `evaluateState`, etc.) plus `AgentTraceEntry` trace logging shape (shared contract with `shorky-cloud`'s `src/lib/types.ts` — keep these in sync). `clickElement`/`fillInput` fall back to `resolveWithFallback()`'s LLM-assisted selector resolution (`healingEngine.ts`) only on a primary-locator timeout, purely within the live exploratory agent session — this in-session fallback is unrelated to the deprecated `clickAndHeal()` runtime-injection fixture (removed from `autoHealFixture.ts`; never wire an `autoHealPage` fixture reference back into `executeAgentTool()`).
  - `generator.ts`: Code Synthesis Engine — converts an agent trace into a static Playwright spec file, and exposes `overwriteSpecInPlace()` used by the auto-heal fixer to patch specs in place.
- **`src/cli/`** — CLI entrypoints.
  - `index.ts`: `commander`-based `shorky run` command; spawns `npx playwright test` as a subprocess and, on failure with `--heal`, triggers the offline self-healing flow — after first running the pre-flight budget check (`preflight.ts`; see below) in `handleHealOnFailure()`.
  - `preflight.ts`: **pre-flight budget guard**, called before any LLM-driven repair loop starts (both from `index.ts`'s `handleHealOnFailure()` and from `fixTrace.ts`'s `runReportFix()`/standalone `runOfflineFix()`). POSTs to shorky-cloud's `/api/v1/preflight` endpoint with the `x-shorky-api-key` header; if the response is `402` (subscription inactive) or `429` (monthly token budget exceeded), the caller must abort before making any OpenAI call and exit non-zero so the CI job fails normally. Skips entirely (treated as pass) when Shorky Cloud isn't configured, and fails *open* (treated as pass) on network errors/timeouts so a shorky-cloud outage never blocks CI — mirrors the offline-friendly philosophy already used by `cloudReporter.ts`.
  - `fixTrace.ts`: the GitHub Action's core logic — parses a Playwright JSON report, resolves failing specs/traces, calls the LLM fixer, applies the patch, stages/opens a consolidated healing PR (branch `shorky/auto-heal-fixes`), and optionally notifies `shorky-cloud` via webhook. Distinguishes DOM/locator failures (LLM-fixable) from visual-regression failures (routed to a "Visual Diff Handoff" PR section for human review instead of an LLM rewrite). `runReportFix()` runs the pre-flight budget check exactly once before its batch loop; standalone `runOfflineFix({ tracePath, specPath })` (non-batch) also runs it internally unless called with `skipPreflightCheck: true` (used by `index.ts`, which already checked). `resolveSuiteRunId()` resolves (rather than always minting) the batch's shared `suiteRunId`, preferring `SHORKY_RUN_ID` (env var, or forwarded via `action.yml`) then `<report-dir>/.shorky-run-id` (written by the consuming project's Playwright `globalSetup` before workers spawn) before falling back to a fresh UUID — this keeps a multi-worker Playwright run's failures grouped into one batch/PR/webhook instead of fragmenting per worker.
- **`src/engine/`** — `traceParser.ts` (locates/parses `trace.zip` and Playwright JSON reports), `codeFixer.ts` (LLM prompt/response wiring for generating a spec fix).
- **`src/fixtures/autoHealFixture.ts`** — a custom Playwright fixture (`test.extend`) providing `autoHealPage` with `assertVisual()` and `assertVisualBaseline()`. The old `clickAndHeal()` runtime-injection pass-through (and its dedicated `tests/self-healing.spec.ts` demo spec) have been removed entirely as dead legacy MVP code — under the finalized "fail-and-rewrite" architecture, tests simply use standard Playwright APIs (`page.click()`, etc.) directly and a failing selector throws a normal Playwright timeout error so `fixTrace.ts` can permanently repair the `.spec.ts` source file itself (see the GitHub Action description above). The fixture still resets the worker-local token counter (`resetTokensUsedThisTest()`) at setup and, at teardown, attaches the tokens consumed during the test (`SHORKY_TOKENS_ATTACHMENT_NAME`) via `testInfo.attach()` for `cloudReporter.ts` to pick up — see "LLM Token Usage Tracking" below.
- **`src/reporters/cloudReporter.ts`** — custom Playwright reporter, only registered in `playwright.config.ts` when `isShorkyCloudEnabled()` is true; POSTs run/test telemetry to `shorky-cloud`'s `/api/v1/telemetry`, including per-test and run-level `tokensUsed` totals (read back out of each test's `SHORKY_TOKENS_ATTACHMENT_NAME` attachment in `onTestEnd()`) and `repoOwner`/`repoName` (via `gitContext.ts`, split from `resolveRepositoryName()`) so the dashboard's repo identity matches the `/api/webhook` self-heal-fix path exactly.
- **`src/config/shorkyCloud.ts`** — single source of truth for all shorky-cloud URLs/env resolution (`getShorkyCloudTelemetryUrl()`, `getShorkyCloudWebhookUrl()`, `getShorkyCloudPreflightUrl()`, `isShorkyCloudEnabled()`, `getShorkyCloudApiKey()`); always extend here rather than hardcoding URLs elsewhere. Also owns `logDashboardCallToAction()`, called once by `cloudReporter.ts` (on successful `/api/v1/telemetry` transmission, or immediately if no API key is configured) and by `fixTrace.ts` (after each standalone fix dispatch, and once per batch run) to print the shorky-cloud dashboard URL/sign-up CTA to the CI log.
- **`src/utils/`** — `githubPr.ts` (branch/PR management for auto-heal), `healingEngine.ts` (selector self-healing + AI vision assertions — used only by the exploratory ReAct agent's `agent/tools.ts`, not by `autoHealFixture.ts`), `visual-diff.ts` (pixelmatch baseline comparison), `llmClient.ts`, `testGenerator.ts`, `tokenUsage.ts` (LLM token usage tracking — see "LLM Token Usage Tracking" below), `gitContext.ts` (`resolveRepositoryName()` — the single shared "owner/repo" resolver used by both `cloudReporter.ts` and `fixTrace.ts`, so the dashboard always shows a consistent repo identity: `GITHUB_REPOSITORY` env var → parsed from local `.git/config`'s `origin` remote URL → `"local/unknown"` fallback).
- **`scripts/`** — standalone maintenance scripts (`generate-test.ts`, `test-fixer.ts`), run via `tsx`, not part of the npm `scripts` block.
- **`tests/`** — currently just `broken-login.spec.ts`, an intentionally-broken spec (stale `getByLabel` locators) repeatedly self-healed by CI to exercise the "fail-and-rewrite" flow end-to-end; expect its locators to be perpetually "broken again" by the auto-heal bot for demo purposes. Playwright's `testDir` is `./tests` (see `playwright.config.ts`); any other demo specs previously here (`generated-login.spec.ts`, `baseline.spec.ts`, `self-healing.spec.ts`) have been deleted as legacy MVP scaffolding. `scripts/generate-test.ts`/`generate-test.ts`'s LLM output writes new specs to `tests/generated-*.spec.ts`, which are gitignored (see `.gitignore`) — don't expect them to persist or be committed.
- **CI:** `.github/workflows/playwright.yml` runs the Playwright suite on push/PR, then on `push` failure invokes the local composite action (`uses: ./`) to run the auto-healer against `test-results/report.json`.
- **Distribution:** the npm `bin` (`shorky`) points at `dist/cli/index.js`, so `npm run build` must be run before publishing/tagging a new action version (the GitHub Action referenced elsewhere as `whoff77/shorky@vX.Y.Z` uses the compiled `dist/` output plus `action.yml`; `shorky-test-consumer` currently pins `v1.3.13`).
- **Style:** favor async/await, explicit TypeScript types (avoid `any`), custom fixtures over raw page objects, and descriptive emoji-tagged console logs (e.g. `🤖 [Shorky]`, `⚠️ [Interceptor]`).

## LLM Token Usage Tracking

To let `shorky-cloud`'s `/api/v1/preflight` budget guard enforce real monthly LLM spend, the CLI captures actual OpenAI token usage and threads it through to the telemetry payload:

1. **Capture (`src/utils/tokenUsage.ts`)** — a small module-level counter (`recordTokenUsage()`, `getTokensUsedThisTest()`, `resetTokensUsedThisTest()`) accumulates `response.usage.total_tokens` from every OpenAI chat-completion call made during test execution:
   - `src/utils/healingEngine.ts` — `healSelector()` (Tier 3 visual-grounding self-heal) and `assertVisual()` (AI vision assertions) both call `recordTokenUsage(response.usage)` immediately after their `openai.chat.completions.create()` call.
   - `src/agent/agentRunner.ts` — `runAgentGoal()`'s ReAct loop calls `recordTokenUsage(response.usage)` on every cycle, and also independently sums `response.usage.total_tokens` into the returned `AgentRunResult.tokensUsed` field (used by `generator.ts`/offline/agent-driven flows that don't go through the Playwright reporter).
   - `src/engine/codeFixer.ts` — `generateSpecFix()` (the GitHub Action's LLM code-fix call) calls `recordTokenUsage(response.usage)` and also returns `tokensUsed` directly on its `FixResult`.
2. **Bridge worker → main process (`src/fixtures/autoHealFixture.ts`)** — Playwright test bodies/fixtures run in worker processes, while `cloudReporter.ts` runs in the main process; there's no shared memory between them. The `autoHealPage` fixture resets the counter at setup (`resetTokensUsedThisTest()`) and, at teardown, snapshots it (`getTokensUsedThisTest()`) and attaches it to the test result via `testInfo.attach(SHORKY_TOKENS_ATTACHMENT_NAME, { body: String(tokensUsed) })`. Safe under `fullyParallel: true` because each worker only ever runs one test at a time and the counter is reset per-test.
3. **Propagate to the reporter (`src/reporters/cloudReporter.ts`)** — `onTestEnd()` reads the `SHORKY_TOKENS_ATTACHMENT_NAME` attachment off `TestResult.attachments` (defaulting to `0` if absent/malformed) and stores it per test. `onEnd()` sums every test's `tokensUsed` into a run-level `totalTokensUsed`.
4. **Outgoing telemetry payload** — the payload POSTed to `/api/v1/telemetry` includes both a run-level `tokensUsed` field and a per-test `tokensUsed` field on each entry in `tests[]`, matching `shorky-cloud`'s `IncomingTelemetryPayload`/`IncomingTestPayload` schema (see `shorky-cloud`'s `src/lib/types.ts` and `src/app/api/v1/telemetry/route.ts`, which atomically increments `projects.tokensUsedThisMonth` by the run-level total, falling back to summing per-test totals if the run-level field is absent).

5. **Webhook path (`src/cli/fixTrace.ts`'s `notifyShorkyCloud()`)** — `autoHealFixture.ts` no longer performs any runtime self-healing (see below), so the tokens tracked for the GitHub Action's fix flow come entirely from `codeFixer.ts`'s `generateSpecFix()` (`response.usage.total_tokens`, returned as `FixResult.tokensUsed`). `runOfflineFix()` threads that value into `HealedFixEntry.tokensUsed`, which both the standalone `notifyShorkyCloud()` dispatch and the batch `notifyShorkyCloudBatch()` loop forward as `tokensUsed` on the `/api/webhook` payload — matching `shorky-cloud`'s `webhookPayloadSchema`'s optional `tokensUsed` field, which atomically increments `projects.tokensUsedThisMonth` the same way `/api/v1/telemetry` does. Both dispatch paths also send a `testName` (extracted from the trace's own metadata by `traceParser.ts`, falling back to the spec's basename) and `repoOwner`/`repoName` (via `gitContext.ts`'s `resolveRepositoryName()`) so the dashboard shows consistent test/repo identifiers regardless of which ingestion path (`/api/webhook` vs. `/api/v1/telemetry`) produced a given record.
