/**
 * Workflow Engine — Public API surface.
 *
 * Re-exports all public types, classes, and provides a convenience factory
 * function ({@link createSpecReviewEngine}) that wires all 8 dependencies
 * together for the Spec-Review workflow.
 *
 * @module workflow
 */

// Re-export all public types
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

// Local imports for the factory function (re-exports above only forward
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

/**
 * Factory function: create a fully-wired WorkflowEngine for Spec-Review.
 * All 8 dependencies are created and wired together.
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

  return new _WorkflowEngine(
    store, packBuilder, promptAssembler, modelInvoker,
    terminationJudge, jsonParser, issueMatcher, patchApplier,
  );
}
