"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNKNOWN_REPOSITORY = void 0;
exports.resolveRepositoryName = resolveRepositoryName;
// src/utils/gitContext.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Fallback repo identity used when neither CI env vars nor local git metadata are available. */
exports.UNKNOWN_REPOSITORY = 'local/unknown';
/**
 * Extracts an "owner/repo" slug from a git remote URL, supporting both the
 * SSH form (`git@github.com:owner/repo.git`) and the HTTPS form
 * (`https://github.com/owner/repo.git`), with or without a trailing `.git`.
 */
function parseOwnerRepoFromRemoteUrl(remoteUrl) {
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
function resolveRepositoryNameFromGitConfig(cwd = process.cwd()) {
    try {
        let currentDir = path_1.default.resolve(cwd);
        // Walk upward until a `.git` directory is found (mirrors how `git`
        // itself resolves the repo root from a nested working directory).
        while (true) {
            const gitConfigPath = path_1.default.join(currentDir, '.git', 'config');
            if (fs_1.default.existsSync(gitConfigPath)) {
                const configContents = fs_1.default.readFileSync(gitConfigPath, 'utf-8');
                // Find the `[remote "origin"]` section and its `url = ...` line.
                const originSectionMatch = configContents.match(/\[remote "origin"\][^[]*/);
                if (originSectionMatch) {
                    const urlLineMatch = originSectionMatch[0].match(/url\s*=\s*(.+)/);
                    if (urlLineMatch) {
                        const ownerRepo = parseOwnerRepoFromRemoteUrl(urlLineMatch[1]);
                        if (ownerRepo)
                            return ownerRepo;
                    }
                }
                return null;
            }
            const parentDir = path_1.default.dirname(currentDir);
            if (parentDir === currentDir)
                return null;
            currentDir = parentDir;
        }
    }
    catch {
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
function resolveRepositoryName() {
    if (process.env.GITHUB_REPOSITORY) {
        return process.env.GITHUB_REPOSITORY;
    }
    const fromGitConfig = resolveRepositoryNameFromGitConfig();
    if (fromGitConfig) {
        return fromGitConfig;
    }
    return exports.UNKNOWN_REPOSITORY;
}
