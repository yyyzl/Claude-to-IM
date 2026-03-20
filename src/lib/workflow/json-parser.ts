/**
 * JsonParser — Best-effort JSON extraction from LLM output.
 *
 * LLM responses often wrap JSON in markdown code fences, trailing commentary,
 * or other non-JSON text. This module implements a multi-strategy parser that
 * tries progressively looser extraction techniques until it succeeds or gives up.
 *
 * @module workflow/json-parser
 */

import type { ClaudeDecisionOutput } from './types.js';

export class JsonParser {
  // ── Public API ──────────────────────────────────────────────

  /**
   * Best-effort JSON extraction from LLM output.
   *
   * Strategy (in order):
   * 1. Direct `JSON.parse()` on trimmed output
   * 2. Strip markdown code fences (` ```json ` blocks) and retry
   * 3. Regex extraction of first `{ ... }` or `[ ... ]` block (bracket counting)
   * 4. Return `null` on failure
   *
   * @typeParam T - Expected shape of the parsed JSON.
   * @param raw - Raw LLM output string.
   * @returns Parsed object of type `T`, or `null` if extraction failed.
   */
  parse<T>(raw: string): T | null {
    if (!raw || typeof raw !== 'string') {
      return null;
    }

    // Strategy 1: direct parse on trimmed input
    const trimmed = raw.trim();
    const direct = tryJsonParse<T>(trimmed);
    if (direct !== null) {
      return direct;
    }

    // Strategy 2: strip markdown code fences and retry
    const stripped = stripCodeFences(trimmed);
    if (stripped !== null) {
      const parsed = tryJsonParse<T>(stripped);
      if (parsed !== null) {
        return parsed;
      }
    }

    // Strategy 3: extract first balanced { ... } or [ ... ] block
    const extracted = extractBalancedBlock(trimmed);
    if (extracted !== null) {
      const parsed = tryJsonParse<T>(extracted);
      if (parsed !== null) {
        return parsed;
      }
    }

    // Strategy 4: give up
    return null;
  }

  /**
   * Extract spec/plan patches from Claude output.
   *
   * Strategy (in order):
   * 1. Read `spec_patch` / `plan_patch` from the pre-parsed JSON object
   * 2. Fallback: scan raw text for `--- SPEC UPDATE ---` / `--- PLAN UPDATE ---` markers
   * 3. Return `null` for any patch not found
   *
   * @param raw - Raw Claude output string.
   * @param parsed - Pre-parsed `ClaudeDecisionOutput`, or `null` if parsing failed.
   * @returns An object containing `specPatch` and `planPatch` (either or both may be `null`).
   */
  extractPatches(
    raw: string,
    parsed: ClaudeDecisionOutput | null,
  ): { specPatch: string | null; planPatch: string | null } {
    let specPatch: string | null = null;
    let planPatch: string | null = null;

    // Strategy 1: read from parsed object
    if (parsed) {
      if (parsed.spec_patch && parsed.spec_patch.trim().length > 0) {
        specPatch = parsed.spec_patch;
      }
      if (parsed.plan_patch && parsed.plan_patch.trim().length > 0) {
        planPatch = parsed.plan_patch;
      }
    }

    // Strategy 2: fallback to marker-based extraction from raw text
    if (specPatch === null) {
      specPatch = extractBetweenMarkers(
        raw,
        '--- SPEC UPDATE ---',
        '--- END SPEC UPDATE ---',
      );
    }

    if (planPatch === null) {
      planPatch = extractBetweenMarkers(
        raw,
        '--- PLAN UPDATE ---',
        '--- END PLAN UPDATE ---',
      );
    }

    return { specPatch, planPatch };
  }
}

// ── Private helpers ────────────────────────────────────────────

/**
 * Attempt `JSON.parse` and return the result, or `null` on any error.
 */
function tryJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Strip markdown code fences from a string.
 *
 * Handles both ` ```json ... ``` ` and bare ` ``` ... ``` ` fences.
 * Returns the inner content (trimmed) if a fence is found, otherwise `null`.
 */
function stripCodeFences(text: string): string | null {
  // Match ```json ... ``` or ``` ... ``` (with optional language tag)
  // The `s` (dotAll) flag makes `.` match newlines.
  const fencePattern = /^```(?:\w+)?\s*\n([\s\S]*?)\n\s*```\s*$/;
  const match = fencePattern.exec(text);
  if (match) {
    return match[1].trim();
  }

  // Also handle cases where the fence is embedded within surrounding text.
  // Extract the content of the first ``` ... ``` block found anywhere in the text.
  const embeddedPattern = /```(?:\w+)?\s*\n([\s\S]*?)\n\s*```/;
  const embeddedMatch = embeddedPattern.exec(text);
  if (embeddedMatch) {
    return embeddedMatch[1].trim();
  }

  return null;
}

/**
 * Extract the first balanced `{ ... }` or `[ ... ]` block from the text
 * using a simple bracket counter.
 *
 * Handles:
 * - Nested braces/brackets
 * - Strings (skips over quoted content to avoid counting braces inside strings)
 *
 * @returns The extracted JSON substring, or `null` if no balanced block is found.
 */
function extractBalancedBlock(text: string): string | null {
  // Find the first '{' or '['
  let startIndex = -1;
  let openChar: string | null = null;
  let closeChar: string | null = null;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      startIndex = i;
      openChar = '{';
      closeChar = '}';
      break;
    }
    if (text[i] === '[') {
      startIndex = i;
      openChar = '[';
      closeChar = ']';
      break;
    }
  }

  if (startIndex === -1 || openChar === null || closeChar === null) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  // Unbalanced — no matching close found
  return null;
}

/**
 * Extract text between two marker lines in the raw output.
 *
 * Looks for exact marker strings (case-sensitive) and returns the content
 * between them, trimmed. Returns `null` if either marker is not found.
 *
 * @param raw - The raw text to search.
 * @param startMarker - The opening marker (e.g. `"--- SPEC UPDATE ---"`).
 * @param endMarker - The closing marker (e.g. `"--- END SPEC UPDATE ---"`).
 * @returns The extracted content between markers (trimmed), or `null`.
 */
function extractBetweenMarkers(
  raw: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const startIdx = raw.indexOf(startMarker);
  if (startIdx === -1) {
    return null;
  }

  const contentStart = startIdx + startMarker.length;
  const endIdx = raw.indexOf(endMarker, contentStart);
  if (endIdx === -1) {
    return null;
  }

  const content = raw.slice(contentStart, endIdx).trim();
  return content.length > 0 ? content : null;
}
