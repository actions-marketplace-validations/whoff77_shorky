import fs from 'fs';
import path from 'path';

/**
 * Strips markdown code fences and stray leading file-path header comments
 * that LLMs sometimes include in generated spec code, and normalizes line
 * endings, so the output is clean, directly-runnable TypeScript.
 */
function sanitizeSpecCode(rawCode: string): string {
  return (
    rawCode
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/i, '')
      .replace(/^\/\/\s*[^\n]*\.spec\.[tj]s\n?/i, '')
      .replace(/\r\n/g, '\n')
      .trim() + '\n'
  );
}

export interface OverwriteSpecInPlaceOptions {
  /** Absolute or cwd-relative path of the original broken spec file to overwrite. */
  specPath: string;
  /** The raw LLM-generated replacement code for that spec file. */
  rawFixedCode: string;
}

export interface OverwriteSpecInPlaceResult {
  /** Whether the file was actually written. */
  written: boolean;
  /** The sanitized code that was (or would have been) written. */
  cleanedCode: string;
  /** Populated when `written` is false, explaining why the write was skipped. */
  reason?: string;
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
export function overwriteSpecInPlace({
  specPath,
  rawFixedCode,
}: OverwriteSpecInPlaceOptions): OverwriteSpecInPlaceResult {
  const cleanedCode = sanitizeSpecCode(rawFixedCode);

  if (!cleanedCode || cleanedCode.length < 30 || !cleanedCode.includes('test(')) {
    return {
      written: false,
      cleanedCode,
      reason: `LLM generated invalid or empty spec code for ${specPath}. Aborting file write to protect the original test file.`,
    };
  }

  const absoluteSpecPath = path.isAbsolute(specPath) ? specPath : path.resolve(specPath);
  fs.mkdirSync(path.dirname(absoluteSpecPath), { recursive: true });
  fs.writeFileSync(absoluteSpecPath, cleanedCode, 'utf-8');

  return { written: true, cleanedCode };
}
