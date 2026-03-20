/**
 * Patch Applier — section-level replacement for Markdown documents.
 *
 * Applies patches to spec/plan documents by matching Markdown headings
 * (any level from `#` to `####`) and replacing the matched section's
 * content with the patch content up to the next heading of the same
 * or higher level.
 *
 * Unmatched patch sections are appended to the end of the document
 * and reported in {@link PatchResult.failedSections}.
 *
 * @module workflow/patch-applier
 */

import type { PatchResult } from './types.js';

// ── Types ────────────────────────────────────────────────────────

/** Internal representation of a parsed Markdown section. */
interface Section {
  /** Heading level (1 = `#`, 2 = `##`, etc.). */
  level: number;
  /** The heading text (trimmed, without the `#` prefix). */
  heading: string;
  /** Start index in the source string (beginning of the heading line). */
  startIdx: number;
  /** End index in the source string (exclusive — start of next section or EOF). */
  endIdx: number;
}

// ── Heading regex ────────────────────────────────────────────────

/**
 * Matches Markdown headings at levels 1-4.
 *
 * Capture groups:
 * - `[1]`: the `#` characters (1-4)
 * - `[2]`: the heading text after the `#` prefix
 *
 * Uses the `gm` flags so `^` matches the start of every line.
 */
const HEADING_PATTERN = /^(#{1,4})\s+(.+)$/gm;

// ── PatchApplier ────────────────────────────────────────────────

export class PatchApplier {
  /**
   * Apply a section-level patch to a Markdown document.
   *
   * For each heading in the `patch`, the applier searches the `currentDoc`
   * for a heading with the **same level and text** (case-sensitive, trimmed).
   *
   * - **Match found**: the section content (from heading to next same-or-higher
   *   level heading, or EOF) is replaced with the patch section content.
   * - **No match**: the patch section is appended at the end of the document,
   *   and the heading is recorded in `failedSections`.
   *
   * @param currentDoc - The current document content to patch.
   * @param patch - The patch content containing replacement sections.
   * @returns A {@link PatchResult} with the merged document and tracking arrays.
   */
  apply(currentDoc: string, patch: string): PatchResult {
    const appliedSections: string[] = [];
    const failedSections: string[] = [];

    // Parse both documents into sections
    const docSections = parseSections(currentDoc);
    const patchSections = parseSections(patch);

    // If there are no sections in the patch, return the document unchanged
    if (patchSections.length === 0) {
      return { merged: currentDoc, appliedSections, failedSections };
    }

    // Process patch sections in reverse order so that index offsets
    // from earlier replacements don't invalidate later ones.
    // But first, collect match info in forward order.
    const replacements: Array<{
      patchSection: Section;
      patchContent: string;
      docSection: Section | null;
    }> = [];

    for (const ps of patchSections) {
      const patchContent = patch.slice(ps.startIdx, ps.endIdx);

      // Find matching section in the current document
      const match = docSections.find(
        (ds) => ds.level === ps.level && ds.heading.trim() === ps.heading.trim(),
      );

      replacements.push({
        patchSection: ps,
        patchContent,
        docSection: match ?? null,
      });
    }

    // Apply replacements in reverse document-position order to preserve indices
    // Separate into: matched (to replace in-place) and unmatched (to append)
    const matched = replacements.filter((r) => r.docSection !== null);
    const unmatched = replacements.filter((r) => r.docSection === null);

    // Sort matched by document position descending (so we replace from end to start)
    matched.sort((a, b) => b.docSection!.startIdx - a.docSection!.startIdx);

    let result = currentDoc;

    for (const { patchSection, patchContent, docSection } of matched) {
      const heading = formatHeading(patchSection.level, patchSection.heading);
      appliedSections.push(heading);

      result =
        result.slice(0, docSection!.startIdx) +
        patchContent +
        result.slice(docSection!.endIdx);
    }

    // Append unmatched sections at the end
    for (const { patchSection, patchContent } of unmatched) {
      const heading = formatHeading(patchSection.level, patchSection.heading);
      failedSections.push(heading);

      // Ensure there is a blank line before appending
      if (result.length > 0 && !result.endsWith('\n\n')) {
        result += result.endsWith('\n') ? '\n' : '\n\n';
      }

      result += patchContent;
    }

    return { merged: result, appliedSections, failedSections };
  }
}

// ── Private helpers ──────────────────────────────────────────────

/**
 * Parse a Markdown document into an array of {@link Section} objects.
 *
 * Each section spans from its heading line to the start of the next
 * heading at the **same or higher level** (i.e. lower or equal `#` count),
 * or to the end of the document.
 */
function parseSections(doc: string): Section[] {
  const headings: Array<{ level: number; heading: string; startIdx: number }> = [];

  // Collect all headings with their positions
  let match: RegExpExecArray | null;
  // Reset lastIndex to ensure clean iteration
  HEADING_PATTERN.lastIndex = 0;

  while ((match = HEADING_PATTERN.exec(doc)) !== null) {
    headings.push({
      level: match[1].length,
      heading: match[2].trim(),
      startIdx: match.index,
    });
  }

  if (headings.length === 0) {
    return [];
  }

  // Compute endIdx for each section:
  // A section ends where the next heading of the SAME or HIGHER level
  // (i.e. level <= current level) begins, or at the end of the document.
  const sections: Section[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    let endIdx = doc.length;

    // Scan forward for the next heading at same or higher level
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= current.level) {
        endIdx = headings[j].startIdx;
        break;
      }
    }

    sections.push({
      level: current.level,
      heading: current.heading,
      startIdx: current.startIdx,
      endIdx,
    });
  }

  return sections;
}

/**
 * Format a heading string for display/tracking (e.g. `"## Architecture"`).
 */
function formatHeading(level: number, text: string): string {
  return '#'.repeat(level) + ' ' + text;
}
