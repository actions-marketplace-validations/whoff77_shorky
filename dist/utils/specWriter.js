"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.overwriteSpecInPlace = overwriteSpecInPlace;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Strips markdown code fences and stray leading file-path header comments
 * that LLMs sometimes include in generated spec code, and normalizes line
 * endings, so the output is clean, directly-runnable TypeScript.
 */
function sanitizeSpecCode(rawCode) {
    return (rawCode
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/i, '')
        .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
        .replace(/\r\n/g, '\n')
        .trim() + '\n');
}
/**
 * Core "code synthesis" step of the healing pipeline: takes the LLM's raw
 * fix for a failing spec and overwrites the *original* broken test file
 * in-place at `specPath` — rather than writing to a new, unreferenced file
 * — so that when CI re-runs the suite on the healing branch, the very same
 * spec file Playwright discovers and executes now contains the corrected
 * code, and the run actually passes.
 *
 * Includes a guardrail that refuses to write empty, truncated, or otherwise
 * clearly-invalid output, protecting the original test file from being
 * wiped out by a malformed LLM response.
 */
function overwriteSpecInPlace({ specPath, rawFixedCode, }) {
    const cleanedCode = sanitizeSpecCode(rawFixedCode);
    if (!cleanedCode || cleanedCode.length < 30 || !cleanedCode.includes('test(')) {
        return {
            written: false,
            cleanedCode,
            reason: `LLM generated invalid or empty spec code for ${specPath}. Aborting file write to protect the original test file.`,
        };
    }
    const absoluteSpecPath = path_1.default.isAbsolute(specPath) ? specPath : path_1.default.resolve(specPath);
    fs_1.default.mkdirSync(path_1.default.dirname(absoluteSpecPath), { recursive: true });
    fs_1.default.writeFileSync(absoluteSpecPath, cleanedCode, 'utf-8');
    return { written: true, cleanedCode };
}
