/**
 * Provenance enforcement (PRD 4.5).
 *
 * "The hard rule: a `Fact` with `provenance.kind === 'model'` renders on the
 * canvas with an unverified badge and cannot be wired into a compute node
 * without an explicit user override that is itself logged. This is the
 * mechanism that prevents a fabricated number from silently becoming an input
 * to a portfolio simulation."
 *
 * Two halves, and the second is the one that usually gets skipped. Refusing
 * the wire is easy. Making the override *logged* means the override cannot be
 * a boolean on the edge that anybody can set: it has to carry who approved it,
 * when, and why, and the check has to reject an override that is missing any
 * of those. An unattributed override is indistinguishable from no override at
 * all, which is what it would become after one refactor.
 *
 * The node-level view (`badgeFor`) exists because the PRD asks for the badge
 * too: an unverified value that renders like a verified one has already lost,
 * whatever the wiring rules say.
 */

import type { Edge, NodeStatus, PicassoNode, UnverifiedOverride } from '@picasso/canvas-core';
import type { Fact } from './blackboard.js';

export function isUnverified(fact: Fact): boolean {
  return fact.provenance.kind === 'model';
}

/** What a fact renders as on the canvas. */
export function badgeFor(fact: Fact): 'verified' | 'unverified' | 'contested' {
  if (fact.contested) return 'contested';
  return isUnverified(fact) ? 'unverified' : 'verified';
}

/** The node status a fact-backed node carries. */
export function statusFor(fact: Fact): NodeStatus {
  return isUnverified(fact) ? 'unverified' : 'ready';
}

export type WireDecision =
  | { allowed: true; overridden: boolean }
  | { allowed: false; reason: string; needsOverride: boolean };

/** An override is only an override if it says who, when and why. */
export function overrideIsValid(override: UnverifiedOverride | undefined): boolean {
  if (!override) return false;
  if (override.approvedBy.trim() === '') return false;
  if (!Number.isFinite(override.approvedAt) || override.approvedAt <= 0) return false;
  return override.reason.trim().length >= 3;
}

/**
 * Whether an unverified value may feed a compute node.
 *
 * `computeKinds` is deliberately a denial list of *consumers*, not of sources:
 * an unverified number on a TextPad is a claim a human reads and can dismiss,
 * and the same number on a MonteCarloNode is an input to a decision. The rule
 * fires at the point where a person stops reading the number and a machine
 * starts using it.
 */
const COMPUTE_KINDS = new Set([
  'TransformNode',
  'CodeNode',
  'MonteCarloNode',
  'BacktestNode',
  'OptimizerNode',
  'FactorNode',
  'ScenarioNode',
  'ScoringNode',
  'StrategyNode',
  'CausalNode',
  'ProbabilityCurveNode',
]);

export function isComputeNode(node: PicassoNode): boolean {
  return COMPUTE_KINDS.has(node.kind);
}

export function checkWire(fact: Fact, target: PicassoNode, edge: Edge): WireDecision {
  if (edge.class !== 'data') {
    // Reference and annotation edges carry meaning, not values. An unverified
    // claim pinned next to a node is exactly what the analyst asked for.
    return { allowed: true, overridden: false };
  }
  if (!isUnverified(fact)) return { allowed: true, overridden: false };
  if (!isComputeNode(target)) return { allowed: true, overridden: false };
  if (overrideIsValid(edge.unverifiedOverride)) return { allowed: true, overridden: true };
  return {
    allowed: false,
    reason:
      edge.unverifiedOverride === undefined
        ? `fact ${fact.id} traces only to a model dispatch and ${target.id} is a compute node`
        : `the override on ${edge.id} does not record an approver, a time and a reason`,
    needsOverride: true,
  };
}

export interface OverrideRecord {
  edgeId: string;
  factId: string;
  targetNodeId: string;
  approvedBy: string;
  approvedAt: number;
  reason: string;
  /** What the value was at the moment of approval, so a later drift is visible. */
  valueAtApproval?: number;
}

/**
 * The override log.
 *
 * Kept separate from the edge because the edge can be deleted and the fact
 * that somebody once approved a fabricated number into a simulation should
 * outlive it.
 */
export class OverrideLog {
  private readonly records: OverrideRecord[] = [];

  approve(fact: Fact, target: PicassoNode, edge: Edge, override: UnverifiedOverride): OverrideRecord {
    if (!overrideIsValid(override)) {
      throw new Error('an override must record an approver, a time and a reason');
    }
    const record: OverrideRecord = {
      edgeId: edge.id,
      factId: fact.id,
      targetNodeId: target.id,
      approvedBy: override.approvedBy,
      approvedAt: override.approvedAt,
      reason: override.reason,
      ...(fact.value ? { valueAtApproval: fact.value.number } : {}),
    };
    this.records.push(record);
    return record;
  }

  all(): readonly OverrideRecord[] {
    return this.records;
  }

  forEdge(edgeId: string): OverrideRecord[] {
    return this.records.filter((r) => r.edgeId === edgeId);
  }
}

/**
 * Every data edge in a document that carries an unverified fact into compute
 * without a valid override.
 *
 * This is the sweep, not the gate: the gate runs at connect time, and this
 * catches the case where a value *became* unverified after the wire was made —
 * a node recomputed by a model, a cell whose source went away.
 */
export function auditDocument(
  edges: readonly Edge[],
  nodes: ReadonlyMap<string, PicassoNode>,
  factForEdge: (edge: Edge) => Fact | undefined,
): Array<{ edge: Edge; reason: string }> {
  const violations: Array<{ edge: Edge; reason: string }> = [];
  for (const edge of edges) {
    const fact = factForEdge(edge);
    if (!fact) continue;
    const target = nodes.get(edge.to.nodeId);
    if (!target) continue;
    const decision = checkWire(fact, target, edge);
    if (!decision.allowed) violations.push({ edge, reason: decision.reason });
  }
  return violations;
}
