/**
 * The AgentNode (PRD 3.3).
 *
 * > `AgentNode`: a persistent agent bound to a subgraph with a role, budget,
 * > and schedule.
 *
 * Four nouns, and each is a limit rather than a feature. An agent that runs
 * unattended on a schedule is the one agent nobody is watching when it does
 * something, so everything here is about what it cannot do.
 *
 * ## Bound means it writes only inside its subgraph
 *
 * The agent reads its subgraph and the subgraph's ancestors — what its nodes
 * are computed from — and writes only its own nodes. A monitoring agent bound
 * to a volatility cluster that decides the portfolio node upstream "needs"
 * updating is refused, however good its reason. The check is on the handle it
 * is given (`AgentScope`), so there is no unchecked path to the document.
 *
 * ## The budget is a ceiling per month, and a run past it does not happen
 *
 * Not a cheaper run, not a partial one: the run is skipped and the skip is
 * recorded with the reason, the way `canvas-router`'s budgets ask rather than
 * degrade. A persistent agent that quietly downgraded itself when money ran
 * short would produce worse output under the same name.
 *
 * ## A missed schedule catches up once
 *
 * An hourly agent on a canvas nobody opened over a long weekend has missed
 * seventy-two runs. Running seventy-two on reopen spends three days' budget in a
 * minute to produce seventy-two answers to a question only the latest one is
 * about. It runs once, and says how many it skipped.
 */

import {
  ancestors,
  type CanvasDocument,
  type NodeID,
  type PicassoNode,
  createNode,
} from '@picasso/canvas-core';
import type { AgentRole } from './blackboard.js';

export const AGENT_ROLES: readonly AgentRole[] = [
  'coordinator', 'retriever', 'extractor', 'quant', 'simulator', 'critic', 'reconciler', 'scribe',
];

export interface AgentSpec {
  id: NodeID;
  role: AgentRole;
  /** The nodes the agent owns. */
  subgraph: readonly NodeID[];
  /** Cents per UTC calendar month. */
  monthlyBudgetCents: number;
  /** Milliseconds between runs. */
  everyMs: number;
}

export function createAgentNode(spec: AgentSpec): PicassoNode {
  if (!AGENT_ROLES.includes(spec.role)) throw new Error(`"${spec.role}" is not an agent role`);
  if (spec.subgraph.length === 0) throw new Error('an agent bound to nothing has nothing to do');
  if (!(spec.monthlyBudgetCents > 0)) throw new Error('an agent needs a positive monthly budget');
  if (!(spec.everyMs >= 60_000)) throw new Error('an agent runs at most once a minute');
  return createNode({
    id: spec.id,
    kind: 'AgentNode',
    binding: 'wired',
    inputs: [],
    outputs: [],
    params: {
      role: spec.role,
      subgraph: [...spec.subgraph],
      monthlyBudgetCents: spec.monthlyBudgetCents,
      everyMs: spec.everyMs,
    },
  });
}

export class OutsideSubgraph extends Error {
  constructor(readonly agentId: NodeID, readonly nodeId: NodeID, readonly verb: 'read' | 'write') {
    super(`agent ${agentId} may not ${verb} ${nodeId}: it is outside the subgraph the agent is bound to`);
    this.name = 'OutsideSubgraph';
  }
}

/**
 * The only handle an agent run gets on the canvas.
 *
 * Reads cover the subgraph and everything it is computed from; writes cover
 * the subgraph alone. There is no method that returns the document itself.
 */
export class AgentScope {
  private readonly owned: ReadonlySet<NodeID>;
  private readonly readable: ReadonlySet<NodeID>;

  constructor(
    private readonly doc: CanvasDocument,
    readonly agentId: NodeID,
    subgraph: readonly NodeID[],
  ) {
    this.owned = new Set(subgraph);
    this.readable = new Set([...subgraph, ...ancestors(doc, subgraph)]);
  }

  canRead(id: NodeID): boolean {
    return this.readable.has(id);
  }

  canWrite(id: NodeID): boolean {
    return this.owned.has(id);
  }

  read(id: NodeID): PicassoNode | undefined {
    if (!this.canRead(id)) throw new OutsideSubgraph(this.agentId, id, 'read');
    const node = this.doc.nodes.get(id);
    return node ? structuredClone(node) : undefined;
  }

  /** Replaces a param on an owned node. */
  setParam(id: NodeID, name: string, value: PicassoNode['params'][string]): void {
    if (!this.canWrite(id)) throw new OutsideSubgraph(this.agentId, id, 'write');
    const node = this.doc.nodes.get(id);
    if (!node) throw new Error(`${id} is not on the canvas`);
    node.params[name] = value;
  }
}

export type RunDecision =
  | { run: true; skippedRuns: number; remainingCents: number }
  | { run: false; reason: 'not_due' | 'budget_exhausted'; nextAt: number; message: string };

function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The schedule and the ledger of one agent. */
export class AgentSchedule {
  private lastRunAt: number | undefined;
  private readonly spent = new Map<string, number>();
  readonly skips: Array<{ at: number; reason: string }> = [];

  constructor(readonly spec: AgentSpec) {}

  /**
   * Whether the agent runs now.
   *
   * Due runs that were missed are counted and collapsed into this one.
   */
  decide(now: number, estimatedCents: number): RunDecision {
    const due = this.lastRunAt === undefined ? now : this.lastRunAt + this.spec.everyMs;
    if (now < due) {
      return { run: false, reason: 'not_due', nextAt: due, message: 'not due yet' };
    }
    const spent = this.spent.get(monthKey(now)) ?? 0;
    const remaining = this.spec.monthlyBudgetCents - spent;
    if (estimatedCents > remaining) {
      const message =
        `this run would cost ${estimatedCents}c and ${remaining}c of ${this.spec.monthlyBudgetCents}c ` +
        'is left this month; it is skipped, not run cheaper';
      this.skips.push({ at: now, reason: message });
      return { run: false, reason: 'budget_exhausted', nextAt: nextMonth(now), message };
    }
    const skippedRuns =
      this.lastRunAt === undefined ? 0 : Math.max(0, Math.floor((now - this.lastRunAt) / this.spec.everyMs) - 1);
    return { run: true, skippedRuns, remainingCents: remaining };
  }

  /** Records a completed run and what it actually cost. */
  record(at: number, costCents: number): void {
    this.lastRunAt = at;
    const key = monthKey(at);
    this.spent.set(key, (this.spent.get(key) ?? 0) + costCents);
  }

  spentIn(month: string): number {
    return this.spent.get(month) ?? 0;
  }
}
