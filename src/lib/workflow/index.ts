/**
 * Workflow Engine — Public API surface.
 *
 * Re-exports all public types, classes, and provides convenience factory
 * functions for creating workflow engines:
 * - {@link createSpecReviewEngine} — Spec-Review workflow (original)
 * - {@link createCodeReviewEngine} — Code-Review workflow (P1b-CR-0)
 * - {@link AutoFixer} — Review-and-Fix post-processor (P1b-CR-1)
 *
 * All P1b-CR-0/CR-1 types (CodeReviewPack, CodeFinding, WorkflowProfile,
 * FixResult, AutoFixOptions, etc.) are automatically exported via
 * `export * from './types.js'`.
 *
 * @module workflow
 */

// Re-export all public types (includes P1b-CR-0 types, profiles, etc.)
export * from './types.js';

// Re-export path resolver (external-repo support)
export { resolveWorkflowPaths, resolveBuiltinAssetRoot } from './path-resolver.js';
export type { WorkflowPaths, ResolveWorkflowPathsOptions } from './path-resolver.js';

// Re-export classes
export { WorkflowStore } from './workflow-store.js';
export type { WorkflowStorePaths } from './workflow-store.js';
export { WorkflowEngine } from './workflow-engine.js';
export { PackBuilder } from './pack-builder.js';
export type { IContextCompressor } from './pack-builder.js';
export { PromptAssembler } from './prompt-assembler.js';
export { ModelInvoker } from './model-invoker.js';
export { TerminationJudge } from './termination-judge.js';
export { ContextCompressor } from './context-compressor.js';
export { JsonParser } from './json-parser.js';
export { IssueMatcher } from './issue-matcher.js';
export { PatchApplier } from './patch-applier.js';
export { DecisionValidator } from './decision-validator.js';
export { DiffReader } from './diff-reader.js';
export { ReportGenerator } from './report-generator.js';
export { AutoFixer } from './auto-fixer.js';

// Local imports for factory functions (re-exports above only forward
// symbols; they do NOT bring them into the current module scope).
import { WorkflowStore as _WorkflowStore } from './workflow-store.js';
import type { WorkflowStorePaths as _WorkflowStorePaths } from './workflow-store.js';
import { WorkflowEngine as _WorkflowEngine } from './workflow-engine.js';
import { PackBuilder as _PackBuilder } from './pack-builder.js';
import { PromptAssembler as _PromptAssembler } from './prompt-assembler.js';
import { ModelInvoker as _ModelInvoker } from './model-invoker.js';
import { TerminationJudge as _TerminationJudge } from './termination-judge.js';
import { ContextCompressor as _ContextCompressor } from './context-compressor.js';
import { JsonParser as _JsonParser } from './json-parser.js';
import { IssueMatcher as _IssueMatcher } from './issue-matcher.js';
import { PatchApplier as _PatchApplier } from './patch-applier.js';
import { DecisionValidator as _DecisionValidator } from './decision-validator.js';

// ── Factory Functions ───────────────────────────────────────────

/**
 * Build a WorkflowEngine with all 9 dependencies wired.
 * Internal helper shared by both factory functions.
 *
 * @param storeInit  - Legacy single basePath string, split paths object, or undefined.
 */
function _buildEngine(storeInit?: string | _WorkflowStorePaths): _WorkflowEngine {
  const store = new _WorkflowStore(storeInit);
  const compressor = new _ContextCompressor();
  const packBuilder = new _PackBuilder(store, compressor);
  const promptAssembler = new _PromptAssembler(store);
  const modelInvoker = new _ModelInvoker();
  const terminationJudge = new _TerminationJudge();
  const jsonParser = new _JsonParser();
  const issueMatcher = new _IssueMatcher();
  const patchApplier = new _PatchApplier();
  const decisionValidator = new _DecisionValidator();

  return new _WorkflowEngine(
    store, packBuilder, promptAssembler, modelInvoker,
    terminationJudge, jsonParser, issueMatcher, patchApplier,
    decisionValidator,
  );
}

/**
 * Factory: create a fully-wired WorkflowEngine for Spec-Review.
 *
 * @param basePath  - Legacy single basePath or split {@link WorkflowStorePaths}.
 *   When a split paths object is provided, templates are loaded from
 *   `templateBasePath` while run artifacts are stored under `runBasePath`.
 *   This enables reviewing external repos that don't carry their own templates.
 */
export function createSpecReviewEngine(basePath?: string | _WorkflowStorePaths): _WorkflowEngine {
  return _buildEngine(basePath);
}

/**
 * Factory: create a fully-wired WorkflowEngine for Code-Review.
 *
 * Same dependencies as Spec-Review — the behavioral difference is
 * driven by {@link CODE_REVIEW_PROFILE} passed to `engine.start()`.
 * PatchApplier is still injected (required by constructor signature)
 * but will NOT be called when `profile.behavior.applyPatches` is false.
 *
 * @param basePath  - Legacy single basePath or split {@link WorkflowStorePaths}.
 */
export function createCodeReviewEngine(basePath?: string | _WorkflowStorePaths): _WorkflowEngine {
  return _buildEngine(basePath);
}
