// src/cli/preflight.ts
//
// Pre-flight governance guard. Called immediately before Shorky starts any
// LLM-driven repair loop (the `shorky run --heal` fallback in
// `src/cli/index.ts`, and the offline/report-driven fixer entrypoints in
// `src/cli/fixTrace.ts`) so a lapsed subscription or an exhausted monthly
// token budget is caught *before* a billable OpenAI call is ever made.
//
// Talks to shorky-cloud's tier-aware `POST /api/v1/governance/preflight`
// endpoint (see that repo's `src/app/api/v1/governance/preflight/route.ts`
// and the shared `evaluateGovernance()` in `src/lib/governance.ts`),
// authenticated via the same `x-shorky-api-key` header pattern used by the
// reporter/webhook. Unlike the legacy `/api/v1/preflight` route (kept
// server-side for backward compatibility only), this route ALWAYS responds
// with HTTP 200 and communicates the actual governance decision via two
// explicit boolean fields in the JSON body:
//   - `allowExecution` — whether the CLI should proceed with its
//     LLM-driven repair loop at all.
//   - `acceptsTelemetry` — whether the CLI should bother sending
//     `/api/v1/telemetry` afterwards (a free-tier project over its cloud
//     storage quota flips this to `false`; Pro is always `true`).
import {
  getShorkyCloudApiKey,
  getShorkyCloudGovernancePreflightUrl,
  isShorkyCloudEnabled,
} from '../config/shorkyCloud';

/**
 * Formats a human-readable free-tier cloud telemetry storage-quota banner
 * line (e.g. "⚠️ 8,200/10,000 free telemetry events used") from a
 * governance `storage` payload, for display in the `shorky run` CLI
 * banner (`src/cli/index.ts`) and/or `handleHealOnFailure()`'s log output.
 * Returns `undefined` when there's nothing worth surfacing: no `storage`
 * data (Pro tier, or the check was skipped/failed open), or usage is still
 * comfortably below the warning threshold.
 *
 * - At/over 100% of quota (mirrors `acceptsTelemetry: false`): a hard
 *   "quota reached, telemetry disabled" warning.
 * - At/over `warnAtRatio` (default 80%) but under 100%: a softer
 *   "used" warning so the caller can see the quota approaching before
 *   telemetry actually stops being stored.
 * - Below `warnAtRatio`: no banner (nothing actionable to show yet).
 */
export function formatStorageBanner(
  storage: PreflightResult['storage'],
  warnAtRatio = 0.8,
): string | undefined {
  if (!storage) return undefined;

  const { eventsStored, storageQuota } = storage;
  if (!Number.isFinite(eventsStored) || !Number.isFinite(storageQuota) || storageQuota <= 0) {
    return undefined;
  }

  const formattedUsed = eventsStored.toLocaleString('en-US');
  const formattedQuota = storageQuota.toLocaleString('en-US');

  if (eventsStored >= storageQuota) {
    return `⚠️ [Shorky] Free tier cloud storage quota reached (${formattedUsed}/${formattedQuota} events) — telemetry uploads are now disabled until you upgrade or free up quota.`;
  }

  if (eventsStored >= storageQuota * warnAtRatio) {
    return `⚠️ [Shorky] ${formattedUsed}/${formattedQuota} free telemetry events used.`;
  }

  return undefined;
}

export interface PreflightResult {
  /** True when the LLM repair loop is clear to proceed. */
  ok: boolean;
  /**
   * True when the check was skipped entirely (cloud reporting disabled, or
   * no API key configured) — the LLM loop is allowed to proceed as if the
   * check passed, since there is nothing to enforce against.
   */
  skipped: boolean;
  /** HTTP status returned by shorky-cloud, when a response was received. */
  status?: number;
  /** Human-readable error message to log/surface, when `ok` is false. */
  message?: string;
  /** Active governance tier ('pro' | 'free'), when returned by shorky-cloud. */
  tier?: 'pro' | 'free';
  /**
   * Whether shorky-cloud will actually store telemetry sent to
   * `/api/v1/telemetry` afterwards. `false` means a free-tier project has
   * hit its cloud storage quota — the CLI should skip the telemetry POST
   * entirely rather than pay the network round-trip just to have it
   * silently dropped server-side.
   */
  acceptsTelemetry?: boolean;
  /** Pro-tier budget guardrail figures, populated only when tier === 'pro'. */
  budget?: {
    tokensUsed: number;
    monthlyTokenLimit: number;
  };
  /** Free-tier storage quota figures, populated only when tier === 'free'. */
  storage?: {
    eventsStored: number;
    storageQuota: number;
  };
}

/**
 * Performs the pre-flight governance check against shorky-cloud.
 *
 * Behavior:
 *  - Skips (returns `{ ok: true, skipped: true }`) when Shorky Cloud
 *    integration isn't configured (no API key) — matches the existing
 *    offline-friendly behavior of `cloudReporter.ts`, since there is no
 *    budget/quota to enforce for local/unconfigured runs.
 *  - HARD GATE ON THE RESPONSE BODY: shorky-cloud's
 *    `/api/v1/governance/preflight` always responds `200`, and communicates
 *    the actual allow/deny decision via `allowExecution` in the JSON body.
 *    A body containing `allowExecution: false` (Pro-tier budget exhausted)
 *    is treated as a hard stop with `ok: false`. This CLI intentionally
 *    does NOT re-implement any tier-checking logic itself (free vs. pro,
 *    budget math, etc.) — that decision is made entirely by shorky-cloud;
 *    the CLI's only job is to honor whatever `allowExecution` value it's
 *    given, and to surface `tier`/`acceptsTelemetry`/`budget`/`storage`
 *    back to the caller for its own logging/UX (e.g. `cloudReporter.ts`
 *    skipping the telemetry POST, or `index.ts`'s CLI banner).
 *  - A legacy 402/429 status is still honored as a hard stop for
 *    defensiveness (in case an older/misconfigured shorky-cloud deployment
 *    is pointed at, or `SHORKY_CLOUD_URL` is manually overridden to the
 *    legacy `/api/v1/preflight` route), even though the governance route
 *    itself never returns those statuses.
 *  - Fails OPEN (`{ ok: true }`) on network errors/timeouts/unexpected
 *    non-2xx error responses (and any 2xx body that omits `allowExecution`
 *    or sets it `true`), so a transient shorky-cloud outage never blocks a
 *    customer's CI pipeline — consistent with how `cloudReporter.ts` and
 *    `fixTrace.ts`'s webhook dispatch already treat connectivity failures
 *    as non-fatal.
 */
export async function runPreflightCheck(): Promise<PreflightResult> {
  const apiKey = getShorkyCloudApiKey();

  if (!isShorkyCloudEnabled() || !apiKey) {
    console.log('ℹ️ [Shorky] SHORKY_CLOUD_API_KEY not configured. Skipping pre-flight governance check.');
    return { ok: true, skipped: true };
  }

  const preflightUrl = getShorkyCloudGovernancePreflightUrl(process.env.SHORKY_CLOUD_URL);

  try {
    console.log(`🚦 [Shorky] Running pre-flight governance check against ${preflightUrl}...`);

    const response = await fetch(preflightUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shorky-api-key': apiKey,
      },
      body: JSON.stringify({}),
      // Short timeout so a slow/offline cloud endpoint never stalls CI.
      signal: AbortSignal.timeout(5000),
    });

    // Defensive legacy fallback: honor a hard 402/429 status exactly like
    // the old `/api/v1/preflight` contract, in case this URL ever resolves
    // to that route instead (e.g. a manually overridden SHORKY_CLOUD_URL).
    // The governance route itself never returns these statuses.
    if (response.status === 402 || response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const message =
        data?.error ||
        (response.status === 402
          ? 'Organization subscription is not active.'
          : 'Monthly LLM token budget exceeded.');
      console.error(`❌ [Shorky] Pre-flight check failed (HTTP ${response.status}): ${message}`);
      return { ok: false, skipped: false, status: response.status, message };
    }

    if (!response.ok) {
      // Any other non-2xx (401 invalid key, 500, etc.) — log a warning but
      // fail open rather than blocking the pipeline on an ambiguous error.
      const data = await response.json().catch(() => ({}));
      console.warn(
        `⚠️ [Shorky] Pre-flight check returned unexpected status ${response.status}: ${data?.error || 'Unknown error'}. Continuing without blocking.`,
      );
      return { ok: true, skipped: false, status: response.status };
    }

    // HARD GATE: a 2xx HTTP status alone does NOT mean the LLM repair loop
    // may proceed. shorky-cloud's `/api/v1/governance/preflight` always
    // returns 200 and communicates the actual allow/deny decision via
    // `allowExecution` in the JSON body. This CLI must treat
    // `allowExecution === false` as a hard stop, WITHOUT re-implementing
    // any tier-checking logic itself — the free/pro/budget decision is
    // made entirely server-side; the CLI only has to honor whatever value
    // it's handed back, and forward the richer `tier`/`acceptsTelemetry`/
    // `budget`/`storage` signals to the caller.
    const data = await response.json().catch(() => ({}));

    const tier = data?.tier === 'pro' || data?.tier === 'free' ? data.tier : undefined;
    const acceptsTelemetry = typeof data?.acceptsTelemetry === 'boolean' ? data.acceptsTelemetry : undefined;
    const budget = data?.budget && typeof data.budget === 'object' ? data.budget : undefined;
    const storage = data?.storage && typeof data.storage === 'object' ? data.storage : undefined;

    if (data?.allowExecution === false) {
      const message = data?.message || 'Monthly token budget exceeded. Healing aborted.';
      console.error(`❌ [Shorky] ${message}`);
      return { ok: false, skipped: false, status: response.status, message, tier, acceptsTelemetry, budget, storage };
    }

    console.log('✅ [Shorky] Pre-flight governance check passed.');
    return { ok: true, skipped: false, status: response.status, tier, acceptsTelemetry, budget, storage };
  } catch (error: any) {
    // Network error, timeout, DNS failure, etc. — fail open.
    console.warn(
      `ℹ️ [Shorky] Pre-flight check unavailable (${error?.message || error}). Continuing offline without blocking the run.`,
    );
    return { ok: true, skipped: false };
  }
}
