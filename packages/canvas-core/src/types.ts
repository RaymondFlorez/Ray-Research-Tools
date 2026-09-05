/**
 * Core type definitions for the Picasso analytic canvas.
 *
 * Mirrors PRD sections 3.2 (binding states), 3.3 (node taxonomy) and
 * Appendix A (core type definitions). These types are the contract shared by
 * the renderer, the graph orchestrator and the AI context builder, so they
 * carry no runtime dependencies.
 */

export type NodeID = string;
export type EdgeID = string;
export type TraceID = string;

/** PRD 3.3. The port type lattice. */
export type PortType =
  | 'series'
  | 'scalar'
  | 'table'
  | 'universe'
  | 'instrument'
  | 'portfolio'
  | 'distribution'
  | 'surface'
  | 'curve'
  | 'event'
  | 'document'
  | 'text'
  | 'signal'
  | 'code';

/** Sampling frequency of a `series` port. */
export type Frequency = 'tick' | 'intraday' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface PortConstraints {
  /** Accepted frequencies. Absent means any frequency is accepted. */
  frequency?: Frequency[];
  /** ISO 4217 code the input must be denominated in. */
  currency?: string;
  /** Minimum number of observations the upstream series must carry. */
  minHistory?: number;
  /** Accepted asset classes, matched against the instrument reference layer. */
  assetClass?: string[];
}

export interface Port {
  id: string;
  name: string;
  type: PortType;
  cardinality: 'one' | 'many';
  required: boolean;
  constraints?: PortConstraints;
  /**
   * Descriptive metadata for an *output* port, used to check the downstream
   * port's constraints at connect time.
   */
  emits?: PortMetadata;
}

/** What an output port actually produces, checked against downstream constraints. */
export interface PortMetadata {
  frequency?: Frequency;
  currency?: string;
  history?: number;
  assetClass?: string;
}

/**
 * PRD 3.2. The three levels of commitment an object on the canvas can hold.
 * `loose` objects never enter the scheduler, hold no cache key and cost nothing.
 */
export type BindingState = 'loose' | 'bound' | 'wired';

export type NodeKind =
  | 'DataTile' | 'ChartNode' | 'TableNode' | 'SurfaceNode' | 'CurveNode'
  | 'UniverseNode' | 'HeatmapNode' | 'TransformNode' | 'CodeNode'
  | 'MonteCarloNode' | 'BacktestNode' | 'OptimizerNode' | 'FactorNode'
  | 'ScenarioNode' | 'CausalNode' | 'ScoringNode' | 'StrategyNode'
  | 'ChainMetricNode' | 'ProbabilityCurveNode' | 'HypothesisNode'
  | 'QueryNode' | 'AgentNode' | 'TextPad' | 'InkLayer' | 'EvidenceNode'
  | 'FrameNode';

export type ParamValue =
  | string
  | number
  | boolean
  | null
  | readonly ParamValue[]
  | { readonly [key: string]: ParamValue };

export type NodeStatus =
  | 'idle'
  | 'stale'
  | 'computing'
  | 'ready'
  | 'error'
  | 'unverified';

export interface NodeRuntimeState {
  status: NodeStatus;
  lastComputedAt?: number;
  cacheKey?: string;
  costCents?: number;
  latencyMs?: number;
  error?: { code: string; message: string; retriable: boolean };
}

export interface ProvenanceRef {
  /** source -> Iceberg snapshot ID, so a value can be re-derived exactly. */
  datasetSnapshots: Record<string, string>;
  /** Canvas time this value was derived at. */
  asof: string;
  computeTrace?: TraceID;
  modelDispatches?: TraceID[];
  /**
   * PRD 4.5. False for any value whose only provenance is a model dispatch.
   * Unverified outputs cannot feed a compute node without a logged override.
   */
  verified: boolean;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface PicassoNode {
  id: NodeID;
  kind: NodeKind;
  binding: BindingState;
  position: Vec2;
  size: Size;
  z: number;
  parentFrame?: NodeID;
  inputs: Port[];
  outputs: Port[];
  params: Record<string, ParamValue>;
  state: NodeRuntimeState;
  provenance: ProvenanceRef;
  /** Data licenses required to render this node. */
  entitlementTags: string[];
  createdBy: 'user' | 'agent';
  agentTrace?: TraceID;
  /** Node implementation version, part of the cache key. */
  nodeVersion?: string;
  /** Pinned nodes evaluate even when off-screen (PRD 3.4.2). */
  pinned?: boolean;
  /** Set on a FrameNode to suppress promotion affordances (PRD 3.2.4). */
  frameMode?: FrameMode;
  /** Populated when a wired node is frozen back to `loose` (PRD 3.2.1). */
  frozen?: FrozenSnapshot;
}

/** PRD 3.2.4. A frame states the intent of the region it encloses. */
export type FrameMode = 'sketch' | 'live' | 'neutral';

export interface FrozenSnapshot {
  /** Values as of the freeze, rendered as a static card. */
  values: Record<string, ParamValue>;
  asof: string;
  frozenAt: number;
  /** Binding state to restore to if the analyst un-freezes. */
  previousBinding: BindingState;
}

export type EdgeClass = 'data' | 'reference' | 'causal' | 'annotation';

export type AdapterKind = 'latest' | 'resample' | 'convert_currency';

export interface CausalEdgeParams {
  sign: 1 | -1;
  elasticity: number;
  lagPeriods: number;
  estimation?: {
    method: 'asserted' | 'local_projection' | 'var' | 'cited';
    window: [string, string];
    r2?: number;
    se?: number;
    citation?: string;
  };
}

export interface Edge {
  id: EdgeID;
  from: { nodeId: NodeID; portId: string };
  to: { nodeId: NodeID; portId: string };
  class: EdgeClass;
  /** Implicit coercion inserted at connect time (PRD 3.4.5). */
  adapter?: AdapterKind;
  causal?: CausalEdgeParams;
  /**
   * PRD 4.5. Records the analyst's explicit, logged override when an
   * unverified output is wired into a compute node.
   */
  unverifiedOverride?: UnverifiedOverride;
}

export interface UnverifiedOverride {
  approvedBy: string;
  approvedAt: number;
  reason: string;
}

/** A canvas document: nodes, edges, and the frames that group them. */
export interface CanvasDocument {
  id: string;
  nodes: Map<NodeID, PicassoNode>;
  edges: Map<EdgeID, Edge>;
}

export interface Scenario {
  id: string;
  name: string;
  probability?: number;
  shocks: Shock[];
  source: 'historical_replay' | 'constructed' | 'imported_thermidor';
}

export type Shock =
  | { kind: 'curve'; currency: string; tenorDeltasBps: Record<string, number> }
  | { kind: 'equity_index'; index: string; pct: number }
  | { kind: 'vol_surface'; underlying: string; parallelVolPts?: number; skewDelta?: number }
  | { kind: 'credit'; bucket: string; spreadBps: number }
  | { kind: 'fx'; pair: string; pct: number }
  | { kind: 'factor'; factor: string; sigma: number };
