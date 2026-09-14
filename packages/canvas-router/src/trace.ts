/**
 * The trace store (PRD 4.7).
 *
 * Every dispatch is recorded with what was asked, which model answered, what it
 * cost, and whether the verifier accepted it. Two things depend on this
 * existing: PRD 4.5's provenance rule — a value whose only source is a model
 * dispatch is `unverified` and cannot feed a compute node without a logged
 * override — and 4.7's eval harness, which rewrites the routing policy's
 * quality numbers from these records rather than from vendor claims.
 */

import type { TaskClass } from './policy.js';

export interface Trace {
  id: string;
  nodeId: string;
  taskClass: TaskClass;
  modelId: string;
  policyVersion: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  /** Absent when nothing verified this answer. */
  verified?: boolean;
  verifierReason?: string;
  /** Present for a pinned, deterministic call. */
  seed?: number;
  escalatedFrom?: string;
  at: number;
}

export interface FleetStats {
  modelId: string;
  taskClass: TaskClass;
  dispatches: number;
  /** Share the verifier accepted. This is what 4.7 feeds back as quality. */
  acceptanceRate: number;
  meanCostCents: number;
  meanLatencyMs: number;
}

export class TraceStore {
  private readonly traces: Trace[] = [];

  record(trace: Trace): void {
    this.traces.push(trace);
  }

  all(): readonly Trace[] {
    return this.traces;
  }

  forNode(nodeId: string): Trace[] {
    return this.traces.filter((t) => t.nodeId === nodeId);
  }

  /**
   * Observed quality per model per class.
   *
   * Only traces that were actually verified count. An unverified dispatch says
   * nothing about quality, and folding it in as a pass would let a class with
   * no verifier drift upward forever.
   */
  stats(): FleetStats[] {
    const groups = new Map<string, Trace[]>();
    for (const trace of this.traces) {
      const key = `${trace.modelId}|${trace.taskClass}`;
      const list = groups.get(key) ?? [];
      list.push(trace);
      groups.set(key, list);
    }

    return [...groups.entries()].map(([key, traces]) => {
      const [modelId, taskClass] = key.split('|') as [string, TaskClass];
      const verified = traces.filter((t) => t.verified !== undefined);
      return {
        modelId,
        taskClass,
        dispatches: traces.length,
        acceptanceRate:
          verified.length === 0
            ? Number.NaN
            : verified.filter((t) => t.verified === true).length / verified.length,
        meanCostCents: traces.reduce((s, t) => s + t.costCents, 0) / traces.length,
        meanLatencyMs: traces.reduce((s, t) => s + t.latencyMs, 0) / traces.length,
      };
    });
  }

  /** Total spend, for the budget's after-the-fact view. */
  spentCents(): number {
    return this.traces.reduce((sum, t) => sum + t.costCents, 0);
  }
}
