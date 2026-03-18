/**
 * Codex passthrough — wraps /codex:xxx commands into role-annotated prompts
 * that are sent through the normal conversation-engine pipeline.
 *
 * Codex roles map to specialised prompt prefixes that instruct the LLM
 * (whether Claude or Codex backend) to behave as a specific expert.
 */

import { CODEX_ROLES } from './passthrough-help.js';

/**
 * Parse a `/codex:xxx args` command and return the prompt text to send
 * to the conversation engine.
 *
 * Returns `null` for `/codex:help` (handled as a static help response).
 * Returns the wrapped prompt string for all other subcommands.
 */
export function buildCodexPassthroughPrompt(command: string, args: string): string | null {
  // /codex:help → caller should return help text, not forward to LLM
  if (command === '/codex:help') return null;

  // /codex:exec <task> → full-power execution
  if (command === '/codex:exec') {
    const task = args || 'Analyze the current codebase';
    return [
      '[Codex Full-Power Execution Mode]',
      'You are a full-stack execution agent. Perform the following task end-to-end:',
      '1. Search and understand the relevant code context',
      '2. Implement the solution',
      '3. Write tests to verify',
      '4. Self-verify (lint, typecheck, test)',
      '',
      `Task: ${task}`,
    ].join('\n');
  }

  // /codex:<role> <task> → role-specific prompt
  const roleName = command.replace('/codex:', '');
  const role = CODEX_ROLES[roleName];

  if (role) {
    const task = args || `Perform ${role.description} on the current codebase`;
    return [
      `[Codex ${roleName.charAt(0).toUpperCase() + roleName.slice(1)} Role — ${role.description}]`,
      '',
      `Task: ${task}`,
    ].join('\n');
  }

  // Non-empty but unrecognised role → reject (catches typos like /codex:reveiw)
  if (roleName) {
    return null;
  }

  // /codex: <free text> — bare prefix with args, treat as free-form Codex task
  if (args) {
    return `[Codex] ${args}`;
  }

  return null;
}
