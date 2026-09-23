/**
 * src/config/shorkyCloud.ts
 *
 * Single source of truth for all Shorky Cloud connection settings
 * (base URLs, endpoint construction, and API key resolution) so that the
 * various consumers (Playwright reporter, CLI trace fixer, config loader,
 * etc.) never hardcode or re-derive these values independently.
 *
 * `SHORKY_CLOUD_URL` is an OPTIONAL override, only needed for local
 * tunneling/custom deployments (e.g. `http://localhost:3000`). Consumers
 * only need to set `SHORKY_CLOUD_API_KEY` (plus `OPENAI_API_KEY`) to enable
 * cloud telemetry and pre-flight governance against the hosted production
 * shorky-cloud instance.
 */

/** Default (production) base origin used for every shorky-cloud endpoint. */
export const DEFAULT_SHORKY_CLOUD_BASE_URL = 'https://shorky-cloud.vercel.app';

/**
 * Prints a one-line call-to-action pointing at the shorky-cloud dashboard,
 * shown once per successful telemetry dispatch (cloudReporter.ts) or fix
 * webhook dispatch (fixTrace.ts). The message differs depending on whether
 * a SHORKY_API_KEY/SHORKY_CLOUD_API_KEY was actually configured for this
 * run, since an unauthenticated/anonymous run has no dashboard to view yet.
 */
export function logDashboardCallToAction(): void {
  if (getShorkyCloudApiKey()) {
    console.log(`📊 View telemetry & run history: ${DEFAULT_SHORKY_CLOUD_BASE_URL}/dashboard`);
  } else {
    console.log(
      `💡 Track CI runs & monitor token usage: ${DEFAULT_SHORKY_CLOUD_BASE_URL} (sign in with GitHub to get your free API key)`,
    );
  }
}

/**
 * Sanitizes a raw SHORKY_CLOUD_URL environment value by trimming whitespace,
 * stripping stray leading/trailing quote characters, and removing any
 * accidental markdown link artifacts (e.g. a value copy-pasted as
 * "[shorky-cloud](https://shorky-cloud.vercel.app)" instead of the bare URL).
 */
export function sanitizeCloudUrl(rawUrl: string): string {
  let sanitized = rawUrl.trim();

  // Strip markdown link syntax, keeping only the URL inside the parentheses:
  // e.g. "[label](https://example.com)" -> "https://example.com"
  const markdownLinkMatch = sanitized.match(/\]\((https?:\/\/[^)]+)\)/);
  if (markdownLinkMatch) {
    sanitized = markdownLinkMatch[1];
  }

  // Strip any remaining stray markdown artifacts like leading "[" / trailing "]"
  sanitized = sanitized.replace(/^\[+/, '').replace(/\]+$/, '');

  // Strip stray surrounding quote characters (single, double, or backtick)
  sanitized = sanitized.trim().replace(/^['"`]+/, '').replace(/['"`]+$/, '');

  return sanitized.trim();
}

/**
 * Resolves the effective, normalized shorky-cloud base origin (scheme +
 * host + port, no path/trailing slash). Defensively guards against
 * legacy/misconfigured `SHORKY_CLOUD_URL` values that still include a
 * subpath and/or trailing slash (e.g.
 * `https://shorky-cloud.vercel.app/api/v1/telemetry/` or
 * `http://localhost:3000/api/v1/telemetry`) — both normalize down to just
 * the origin (`https://shorky-cloud.vercel.app` / `http://localhost:3000`).
 *
 * `SHORKY_CLOUD_URL` is an OPTIONAL override for local tunneling/custom
 * deployments only; when unset (or blank/whitespace-only), or when the
 * provided value fails to parse as a URL at all, this falls back to the
 * production `DEFAULT_SHORKY_CLOUD_BASE_URL` rather than throwing — a
 * malformed override should never hard-crash the CLI/reporter.
 *
 * @param overrideUrl Optional explicit override, taking precedence over
 *   `process.env.SHORKY_CLOUD_URL` when provided (used by call sites that
 *   accept their own override parameter, e.g. `getShorkyCloudWebhookUrl`).
 */
export function getShorkyCloudBaseUrl(overrideUrl?: string): string {
  const raw = overrideUrl ?? process.env.SHORKY_CLOUD_URL;
  if (!raw || !raw.trim()) {
    return DEFAULT_SHORKY_CLOUD_BASE_URL;
  }

  const sanitized = sanitizeCloudUrl(raw);
  if (!sanitized) {
    return DEFAULT_SHORKY_CLOUD_BASE_URL;
  }

  try {
    return new URL(sanitized).origin;
  } catch {
    // Malformed URL string (e.g. missing scheme) — fail safe to production
    // rather than propagating an exception up into the CLI/reporter.
    return DEFAULT_SHORKY_CLOUD_BASE_URL;
  }
}

/**
 * Returns whether Shorky Cloud reporting/integration should be considered
 * enabled for the current process. Enabled purely by the presence of
 * `SHORKY_CLOUD_API_KEY` — `SHORKY_CLOUD_URL` is an optional override and
 * must never be required to activate cloud features.
 */
export function isShorkyCloudEnabled(): boolean {
  return Boolean(process.env.SHORKY_CLOUD_API_KEY);
}

/**
 * Resolves the shorky-cloud API key from the environment. Centralized so
 * every caller shares the exact same fallback ('') and env var name.
 */
export function getShorkyCloudApiKey(): string {
  return process.env.SHORKY_CLOUD_API_KEY || '';
}

/**
 * Resolves the fully-qualified telemetry endpoint used by the Playwright
 * reporter to POST run summaries after each test run.
 */
export function getShorkyCloudTelemetryUrl(): string {
  return `${getShorkyCloudBaseUrl()}/api/v1/telemetry`;
}

/**
 * Resolves the fully-qualified webhook endpoint (`/api/webhook`) used by
 * the CLI auto-fix flow to notify shorky-cloud of generated fixes or
 * dispatch failure telemetry. Accepts an optional override URL (e.g. a
 * caller-supplied `process.env.SHORKY_CLOUD_URL`), normalized down to its
 * origin exactly like every other shorky-cloud endpoint resolver.
 */
export function getShorkyCloudWebhookUrl(overrideUrl?: string): string {
  return `${getShorkyCloudBaseUrl(overrideUrl)}/api/webhook`;
}

/**
 * Resolves the fully-qualified tier-aware governance pre-flight endpoint
 * (`/api/v1/governance/preflight`) that the CLI/action calls before
 * starting any LLM-driven repair loop (see `src/cli/preflight.ts`).
 * Accepts the same optional override-URL pattern as
 * `getShorkyCloudWebhookUrl`.
 *
 * Supersedes the legacy `/api/v1/preflight` route (kept server-side by
 * shorky-cloud for backward compatibility only) now that `preflight.ts`
 * has been migrated to consume the always-200
 * `allowExecution`/`acceptsTelemetry` contract exposed by
 * `/api/v1/governance/preflight` instead of the old hard 402/429 HTTP
 * status contract.
 */
export function getShorkyCloudGovernancePreflightUrl(overrideUrl?: string): string {
  return `${getShorkyCloudBaseUrl(overrideUrl)}/api/v1/governance/preflight`;
}
