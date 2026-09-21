// src/utils/gitContext.ts
import fs from 'fs';
import path from 'path';

/** Fallback repo identity used when neither CI env vars nor local git metadata are available. */
export const UNKNOWN_REPOSITORY = 'local/unknown';

/**
 * Extracts an "owner/repo" slug from a git remote URL, supporting both the
 * SSH form (`git@github.com:owner/repo.git`) and the HTTPS form
 * (`https://github.com/owner/repo.git`), with or without a trailing `.git`.
 */
function parseOwnerRepoFromRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  // SSH form: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?\/?$/);
  if (sshMatch && sshMatch[1].includes('/')) {
    return sshMatch[1];
  }

  // HTTPS/git form: https://github.com/owner/repo.git or git://github.com/owner/repo.git
  const urlMatch = trimmed.match(/^[a-zA-Z]+:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (urlMatch && urlMatch[1].includes('/')) {
    return urlMatch[1];
  }

  return null;
}

/**
 * Reads the local `.git/config` file (starting from `cwd` and walking
 * upward) and extracts the "owner/repo" slug from the `[remote "origin"]`
 * section's `url` value, if present.
 */
function resolveRepositoryNameFromGitConfig(cwd: string = process.cwd()): string | null {
  try {
    let currentDir = path.resolve(cwd);

    // Walk upward until a `.git` directory is found (mirrors how `git`
    // itself resolves the repo root from a nested working directory).
    while (true) {
      const gitConfigPath = path.join(currentDir, '.git', 'config');
      if (fs.existsSync(gitConfigPath)) {
        const configContents = fs.readFileSync(gitConfigPath, 'utf-8');

        // Find the `[remote "origin"]` section and its `url = ...` line.
        const originSectionMatch = configContents.match(
          /\[remote "origin"\][^[]*/
        );
        if (originSectionMatch) {
          const urlLineMatch = originSectionMatch[0].match(/url\s*=\s*(.+)/);
          if (urlLineMatch) {
            const ownerRepo = parseOwnerRepoFromRemoteUrl(urlLineMatch[1]);
            if (ownerRepo) return ownerRepo;
          }
        }
        return null;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) return null;
      currentDir = parentDir;
    }
  } catch {
    return null;
  }
}

/**
 * Resolves the "owner/repo" slug used consistently across the codebase
 * (webhook payloads, telemetry, PR creation) to identify which repository
 * a given run belongs to.
 *
 * Resolution order:
 *  1. `GITHUB_REPOSITORY` env var (always set inside GitHub Actions).
 *  2. The local `.git/config` file's `[remote "origin"]` URL, parsed into
 *     `owner/repo` (covers local/offline runs outside CI).
 *  3. `"local/unknown"` — a stable fallback so callers never have to
 *     special-case an empty/undefined value.
 */
export function resolveRepositoryName(): string {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  const fromGitConfig = resolveRepositoryNameFromGitConfig();
  if (fromGitConfig) {
    return fromGitConfig;
  }

  return UNKNOWN_REPOSITORY;
}
