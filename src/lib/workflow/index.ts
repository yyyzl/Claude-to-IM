/**
 * Workflow Engine — Public API surface.
 *
 * Re-exports all public types, classes, and provides convenience factory
 * functions for creating workflow engines:
 * - {@link createSpecReviewEngine} — Spec-Review workflow (original)
 * - {@link createCodeReviewEngine} — Code-Review workflow (P1b-CR-0)
 *
 * All P1b-CR-0 types (CodeReviewPack, CodeFinding, WorkflowProfile, etc.)
 * are automatically exported via `export * from './types.js'`.
 *
 * @module workflow
 */

// Re-export all public types (includes P1b-CR-0 types, profiles, etc.)
export * from './types.js';

// Re-export classes
export { WorkflowStore } from './workflow-store.js';
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

// Local imports for factory functions (re-exports above only forward
// symbols; they do NOT bring them into the current module scope).
import { WorkflowStore as _WorkflowStore } from './workflow-store.js';
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
 * Factory: create a fully-wired WorkflowEngine for Spec-Review.
 *
 * All 9 dependencies are created and wired together.
 * ContextCompressor is injected into PackBuilder (not directly into engine).
 */
export function createSpecReviewEngine(basePath?: string): _WorkflowEngine {
  const store = new _WorkflowStore(basePath);
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
 * Factory: create a fully-wired WorkflowEngine for Code-Review.
 *
 * Same dependencies as Spec-Review — the behavioral difference is
 * driven by {@link CODE_REVIEW_PROFILE} passed to `engine.start()`.
 * PatchApplier is still injected (required by constructor signature)
 * but will NOT be called when `profile.behavior.applyPatches` is false.
 */
export function createCodeReviewEngine(basePath?: string): _WorkflowEngine {
  const store = new _WorkflowStore(basePath);
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
