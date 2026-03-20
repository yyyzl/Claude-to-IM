/**
 * Unit tests for PatchApplier — section-level Markdown replacement engine.
 *
 * Covers:
 * - Single section replacement at ## level (exact heading match)
 * - Single section replacement at ### level (subsection)
 * - Multiple sections in one patch (mixed ## and ### levels)
 * - Heading not found → section appended to end + recorded as failedSections
 * - Empty patch → no-op, return original document
 * - Patch with new section not in original → appended
 * - Replacing ### X does NOT affect sibling ### Y
 * - Heading level mismatch (## Foo vs ### Foo) → failedSections
 * - #### level heading replacement
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PatchApplier } from '../../lib/workflow/patch-applier.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Trim leading blank line from template literals for readability. */
function dedent(s: string): string {
  // Remove the first line if it's empty (template literal artifact)
  return s.startsWith('\n') ? s.slice(1) : s;
}

// ── Tests ────────────────────────────────────────────────────────

describe('PatchApplier', () => {
  const applier = new PatchApplier();

  // ── 1. Single section replacement at ## level ─────────────────

  describe('single section replacement at ## level', () => {
    it('replaces a matched ## section in-place', () => {
      const doc = dedent(`
## Introduction
Original introduction content.

## Architecture
Old architecture description.

## Deployment
Deployment steps here.
`);

      const patch = dedent(`
## Architecture
New architecture description with diagrams.
`);

      const result = applier.apply(doc, patch);

      // The Architecture section should be replaced
      assert.ok(result.merged.includes('New architecture description with diagrams.'));
      assert.ok(!result.merged.includes('Old architecture description.'));

      // Other sections remain untouched
      assert.ok(result.merged.includes('Original introduction content.'));
      assert.ok(result.merged.includes('Deployment steps here.'));

      // Tracking arrays
      assert.deepStrictEqual(result.appliedSections, ['## Architecture']);
      assert.deepStrictEqual(result.failedSections, []);
    });
  });

  // ── 2. Single section replacement at ### level ────────────────

  describe('single section replacement at ### level', () => {
    it('replaces a matched ### subsection in-place', () => {
      const doc = dedent(`
## Components
Overview of components.

### Auth Module
Old auth module description.

### Database Layer
Database layer description.
`);

      const patch = dedent(`
### Auth Module
Rewritten auth module with OAuth2 support.
`);

      const result = applier.apply(doc, patch);

      assert.ok(result.merged.includes('Rewritten auth module with OAuth2 support.'));
      assert.ok(!result.merged.includes('Old auth module description.'));
      // Sibling subsection untouched
      assert.ok(result.merged.includes('Database layer description.'));
      // Parent section untouched
      assert.ok(result.merged.includes('Overview of components.'));

      assert.deepStrictEqual(result.appliedSections, ['### Auth Module']);
      assert.deepStrictEqual(result.failedSections, []);
    });
  });

  // ── 3. Multiple sections in one patch (mixed ## and ### levels) ──

  describe('multiple sections in one patch (mixed levels)', () => {
    it('replaces multiple matched sections in a single apply call', () => {
      const doc = dedent(`
## Overview
Original overview.

## API Design
Old API design.

### Endpoints
Old endpoint list.

## Testing
Old testing strategy.
`);

      const patch = dedent(`
## API Design
New API design with REST + GraphQL.

### Endpoints
Updated endpoint list:
- GET /users
- POST /users

## Testing
New testing strategy with coverage targets.
`);

      const result = applier.apply(doc, patch);

      // All patched sections replaced
      assert.ok(result.merged.includes('New API design with REST + GraphQL.'));
      assert.ok(result.merged.includes('Updated endpoint list:'));
      assert.ok(result.merged.includes('New testing strategy with coverage targets.'));

      // Old content gone
      assert.ok(!result.merged.includes('Old API design.'));
      assert.ok(!result.merged.includes('Old endpoint list.'));
      assert.ok(!result.merged.includes('Old testing strategy.'));

      // Untouched section remains
      assert.ok(result.merged.includes('Original overview.'));

      // appliedSections should list all three
      assert.equal(result.appliedSections.length, 3);
      assert.ok(result.appliedSections.includes('## API Design'));
      assert.ok(result.appliedSections.includes('### Endpoints'));
      assert.ok(result.appliedSections.includes('## Testing'));
      assert.deepStrictEqual(result.failedSections, []);
    });
  });

  // ── 4. Heading not found → appended + failedSections ──────────

  describe('heading not found → appended to end', () => {
    it('appends unmatched section and records it in failedSections', () => {
      const doc = dedent(`
## Introduction
Some intro content.

## Architecture
Existing architecture.
`);

      const patch = dedent(`
## Security
New security considerations.
`);

      const result = applier.apply(doc, patch);

      // The patch content should appear at the end
      assert.ok(result.merged.includes('## Security'));
      assert.ok(result.merged.includes('New security considerations.'));

      // Original content preserved
      assert.ok(result.merged.includes('Some intro content.'));
      assert.ok(result.merged.includes('Existing architecture.'));

      // The unmatched section appears after the original content
      const securityIdx = result.merged.indexOf('## Security');
      const archIdx = result.merged.indexOf('## Architecture');
      assert.ok(securityIdx > archIdx, 'Unmatched section should be appended after existing content');

      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, ['## Security']);
    });
  });

  // ── 5. Empty patch → no-op ────────────────────────────────────

  describe('empty patch → no-op', () => {
    it('returns the original document unchanged when patch is empty', () => {
      const doc = dedent(`
## Introduction
Some content here.

## Details
More details.
`);

      const result = applier.apply(doc, '');

      assert.equal(result.merged, doc);
      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, []);
    });

    it('returns original document when patch has no headings', () => {
      const doc = '## Title\nContent here.\n';
      const patch = 'Just some text without any headings.\n';

      const result = applier.apply(doc, patch);

      assert.equal(result.merged, doc);
      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, []);
    });
  });

  // ── 6. Patch with new section not in original → appended ──────

  describe('patch with entirely new section', () => {
    it('appends a brand-new section to the end of the document', () => {
      const doc = dedent(`
## Existing Section
Existing content.
`);

      const patch = dedent(`
## Brand New Section
This section does not exist in the original.
`);

      const result = applier.apply(doc, patch);

      assert.ok(result.merged.includes('## Brand New Section'));
      assert.ok(result.merged.includes('This section does not exist in the original.'));
      assert.ok(result.merged.includes('Existing content.'));

      // New section should be at the end (after existing content)
      const existingIdx = result.merged.indexOf('## Existing Section');
      const newIdx = result.merged.indexOf('## Brand New Section');
      assert.ok(newIdx > existingIdx);

      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, ['## Brand New Section']);
    });
  });

  // ── 7. Replacing ### X does NOT affect sibling ### Y ──────────

  describe('replacing ### X does NOT affect sibling ### Y', () => {
    it('only replaces the targeted subsection, leaving siblings intact', () => {
      const doc = dedent(`
## Parent
Parent content.

### Alpha
Alpha original content.
Alpha has multiple lines.

### Beta
Beta original content.
Beta also has multiple lines.

### Gamma
Gamma original content.
`);

      const patch = dedent(`
### Beta
Beta REPLACED content.
`);

      const result = applier.apply(doc, patch);

      // Beta replaced
      assert.ok(result.merged.includes('Beta REPLACED content.'));
      assert.ok(!result.merged.includes('Beta original content.'));

      // Alpha untouched
      assert.ok(result.merged.includes('Alpha original content.'));
      assert.ok(result.merged.includes('Alpha has multiple lines.'));

      // Gamma untouched
      assert.ok(result.merged.includes('Gamma original content.'));

      // Parent untouched
      assert.ok(result.merged.includes('Parent content.'));

      assert.deepStrictEqual(result.appliedSections, ['### Beta']);
      assert.deepStrictEqual(result.failedSections, []);
    });
  });

  // ── 8. Heading level mismatch → failedSections ───────────────

  describe('heading level mismatch', () => {
    it('treats ## Foo and ### Foo as different sections (no match)', () => {
      const doc = dedent(`
## Foo
Content under level-2 Foo.

## Bar
Content under Bar.
`);

      const patch = dedent(`
### Foo
This patch targets ### Foo, which does not exist.
`);

      const result = applier.apply(doc, patch);

      // Original ## Foo should be untouched
      assert.ok(result.merged.includes('Content under level-2 Foo.'));

      // ### Foo should be appended (not matched to ## Foo)
      assert.ok(result.merged.includes('### Foo'));
      assert.ok(result.merged.includes('This patch targets ### Foo, which does not exist.'));

      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, ['### Foo']);
    });

    it('treats ### Bar and ## Bar as different sections', () => {
      const doc = dedent(`
### Bar
Subsection bar content.
`);

      const patch = dedent(`
## Bar
This is a level-2 Bar patch.
`);

      const result = applier.apply(doc, patch);

      // Original ### Bar untouched
      assert.ok(result.merged.includes('Subsection bar content.'));

      // ## Bar appended
      assert.ok(result.merged.includes('## Bar'));
      assert.ok(result.merged.includes('This is a level-2 Bar patch.'));

      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, ['## Bar']);
    });
  });

  // ── 9. #### level heading replacement ─────────────────────────

  describe('#### level heading replacement', () => {
    it('replaces a matched #### section in-place', () => {
      const doc = dedent(`
## API
API overview.

### Authentication
Auth overview.

#### OAuth2 Flow
Old OAuth2 flow description.

#### JWT Validation
JWT validation steps.

### Authorization
Authorization overview.
`);

      const patch = dedent(`
#### OAuth2 Flow
New OAuth2 flow with PKCE support.
`);

      const result = applier.apply(doc, patch);

      // #### OAuth2 Flow replaced
      assert.ok(result.merged.includes('New OAuth2 flow with PKCE support.'));
      assert.ok(!result.merged.includes('Old OAuth2 flow description.'));

      // Sibling #### JWT Validation untouched
      assert.ok(result.merged.includes('JWT validation steps.'));

      // Parent sections untouched
      assert.ok(result.merged.includes('API overview.'));
      assert.ok(result.merged.includes('Auth overview.'));
      assert.ok(result.merged.includes('Authorization overview.'));

      assert.deepStrictEqual(result.appliedSections, ['#### OAuth2 Flow']);
      assert.deepStrictEqual(result.failedSections, []);
    });

    it('appends #### section when heading not found in document', () => {
      const doc = dedent(`
## API
API content.
`);

      const patch = dedent(`
#### Deep Nested
New deeply nested section.
`);

      const result = applier.apply(doc, patch);

      assert.ok(result.merged.includes('#### Deep Nested'));
      assert.ok(result.merged.includes('New deeply nested section.'));
      assert.ok(result.merged.includes('API content.'));

      assert.deepStrictEqual(result.appliedSections, []);
      assert.deepStrictEqual(result.failedSections, ['#### Deep Nested']);
    });
  });
});
