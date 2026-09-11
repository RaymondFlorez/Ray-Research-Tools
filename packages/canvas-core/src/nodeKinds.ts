/**
 * Node-kind classification.
 *
 * The graph engine needs to know three things about a kind that the node
 * instance itself does not carry: whether it consumes values as *computation*
 * (which gates the unverified-input rule of PRD 4.5), whether it participates
 * in the explicitly cyclic causal subgraph (PRD 3.4.4), and whether it can
 * hold ink rather than data.
 */

import type { NodeKind } from './types.js';

/**
 * PRD 4.5: a value whose only provenance is a model dispatch "cannot be wired
 * into a compute node without an explicit user override that is itself logged".
 * These are the kinds that count as compute for that rule: kinds that consume
 * an input as a number rather than displaying or annotating it.
 */
const COMPUTE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
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
  'HypothesisNode',
]);

/** Kinds that render a value without computing on it. */
const DISPLAY_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'DataTile',
  'ChartNode',
  'TableNode',
  'SurfaceNode',
  'CurveNode',
  'HeatmapNode',
  'UniverseNode',
  'ChainMetricNode',
  'EvidenceNode',
  'TextPad',
]);

/** Kinds that hold ink or freeform content rather than a typed value. */
const FREEFORM_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['InkLayer', 'FrameNode', 'TextPad']);

export function isComputeKind(kind: NodeKind): boolean {
  return COMPUTE_KINDS.has(kind);
}

export function isDisplayKind(kind: NodeKind): boolean {
  return DISPLAY_KINDS.has(kind);
}

export function isFreeformKind(kind: NodeKind): boolean {
  return FREEFORM_KINDS.has(kind);
}

/**
 * PRD 3.4.4: the general DAG forbids cycles; causal graphs are the exception
 * and evaluate under discrete-time fixed-point semantics.
 */
export function isCausalKind(kind: NodeKind): boolean {
  return kind === 'CausalNode';
}
