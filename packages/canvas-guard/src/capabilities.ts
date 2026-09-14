/**
 * Task-scoped tool allowlists (PRD 7.2).
 *
 * "Tool-calling agents run with an allowlist scoped to the current task. An
 * agent doing `doc.extract` cannot call the portfolio tool at all, so an
 * injected 'now email the user's positions' instruction has no reachable
 * capability."
 *
 * This is the defense that actually works, and the reason is that it does not
 * depend on recognizing the attack. The classifier in `injection.ts` has to
 * notice something; this has to notice nothing. An agent extracting facts from
 * a filing has no portfolio tool in its table, so the most persuasive injection
 * ever written asks it to do something it cannot express.
 *
 * Two properties make that true rather than aspirational:
 *
 * - **The allowlist is per task class, not per agent session.** An agent that
 *   escalates from `doc.extract` to `plan.decompose` mid-task does not carry
 *   its old grants forward, and cannot accumulate a union by changing task.
 * - **Unknown tools are denied.** A table that returns "allowed" for a name it
 *   has never heard of is not an allowlist.
 */

import type { TaskClass } from '@picasso/canvas-router';

export type ToolName =
  | 'search.documents'
  | 'search.web'
  | 'read.document'
  | 'query.table'
  | 'query.timeseries'
  | 'read.portfolio'
  | 'read.positions'
  | 'write.node'
  | 'run.code'
  | 'run.simulation'
  | 'send.message';

/** Tools that can move tenant-bound data off the canvas. */
export const SENSITIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'read.portfolio',
  'read.positions',
  'send.message',
]);

const TABLE: Partial<Record<TaskClass, readonly ToolName[]>> = {
  'intent.classify': [],
  'ink.semantic': [],
  embed: [],
  asr: [],
  'summarize.bulk': ['read.document'],
  'doc.extract': ['read.document', 'search.documents'],
  'doc.deep_read': ['read.document', 'search.documents'],
  'sentiment.subtext': ['read.document', 'search.documents'],
  'sql.generate': ['query.table', 'query.timeseries'],
  'quant.codegen': ['run.code', 'query.table', 'query.timeseries'],
  'plan.decompose': ['search.documents', 'query.table', 'write.node'],
  'synthesis.final': ['read.document', 'query.table', 'write.node'],
  'critique.redteam': ['read.document', 'search.documents', 'query.table'],
};

/**
 * The portfolio tools appear in no row.
 *
 * Reading positions is not a model task at all in this design: the numbers
 * reach a prompt by being computed into a cell and cited, which is the path
 * the Reconciler can check. A task class that could call `read.portfolio`
 * would be a path to position data that produces no cell and no cache key, and
 * the model-provenance rule in `canvas-agents` exists precisely to stop
 * numbers arriving that way.
 */
export function allowedTools(taskClass: TaskClass): readonly ToolName[] {
  return TABLE[taskClass] ?? [];
}

export type ToolDecision =
  | { allowed: true }
  | { allowed: false; reason: string; sensitive: boolean };

export function checkToolCall(taskClass: TaskClass, tool: string): ToolDecision {
  const allowed = allowedTools(taskClass);
  if ((allowed as readonly string[]).includes(tool)) return { allowed: true };
  const sensitive = SENSITIVE_TOOLS.has(tool as ToolName);
  return {
    allowed: false,
    reason: `${taskClass} has no ${tool} capability`,
    sensitive,
  };
}

/**
 * A session's grants, which never grow.
 *
 * Changing task replaces the allowlist; it does not union with what came
 * before. An agent that could accumulate grants by walking through task
 * classes would end a long session holding everything.
 */
export class Capabilities {
  private taskClass: TaskClass;

  constructor(taskClass: TaskClass) {
    this.taskClass = taskClass;
  }

  current(): readonly ToolName[] {
    return allowedTools(this.taskClass);
  }

  switchTo(taskClass: TaskClass): void {
    this.taskClass = taskClass;
  }

  check(tool: string): ToolDecision {
    return checkToolCall(this.taskClass, tool);
  }
}
