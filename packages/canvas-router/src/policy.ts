/**
 * The routing policy (PRD 4.2).
 *
 * "Nothing in that table is hardcoded in application logic. It lives in a
 * versioned routing policy document that the eval harness rewrites."
 *
 * So the table is data with a version on it, and the router below reads it.
 * That is not a stylistic preference: section 4.7 has the eval harness
 * *rewriting* these entries as measured quality changes, and a policy compiled
 * into the dispatcher cannot be rewritten by anything but a deploy.
 */

export type TaskClass =
  | 'intent.classify'
  | 'ink.semantic'
  | 'sql.generate'
  | 'quant.codegen'
  | 'doc.extract'
  | 'doc.deep_read'
  | 'sentiment.subtext'
  | 'plan.decompose'
  | 'synthesis.final'
  | 'critique.redteam'
  | 'summarize.bulk'
  | 'embed'
  | 'asr';

/** Where a model runs, which is what data sensitivity actually turns on. */
export type Placement =
  /** In the browser. Nothing leaves the device. */
  | 'on_device'
  /** The tenant's own cluster. Nothing leaves the tenant boundary. */
  | 'self_hosted'
  /** A third-party API. Data crosses an org boundary. */
  | 'vendor';

export interface Model {
  id: string;
  vendor: string;
  /**
   * Model family within the vendor.
   *
   * Appendix C.5's independence ladder has a tier for "same vendor, different
   * model family", which cannot be evaluated from the vendor alone: two
   * checkpoints of one family share the failure modes the Critic exists to
   * avoid, and two families from one vendor do not share them nearly as much.
   */
  family?: string;
  /** Parameter count in billions, where it is known. Open-weight tiers cite it. */
  paramsB?: number;
  placement: Placement;
  /** Cents per thousand tokens, input and output blended. */
  centsPerKiloToken: number;
  /** Median latency for a short request. */
  latencyMsP50: number;
  latencyMsP95: number;
  /**
   * Quality per task class, from the internal eval harness.
   *
   * PRD 4.3: "`quality(m, taskClass)` comes from the internal eval harness
   * (section 4.7), not from vendor benchmarks." Absent means untested on that
   * class, which is different from scoring zero — an untested model is not a
   * candidate.
   */
  quality: Partial<Record<TaskClass, number>>;
  /** Supports a pinned version and temperature zero. */
  deterministic: boolean;
  contextTokens: number;
}

/** One row of the 4.2 table. */
export interface PolicyEntry {
  taskClass: TaskClass;
  latencySloMs: number;
  /** Model ids, in preference order. */
  primary: string[];
  fallback: string[];
  /** Below this verifier confidence, escalate a tier. */
  escalateBelowConfidence?: number;
  /** Escalate after this many verification failures. */
  escalateAfterFailures?: number;
  /** Some classes go straight to the top, whatever a score would say. */
  alwaysEscalate?: boolean;
}

export interface RoutingPolicy {
  version: string;
  /** When the eval harness last rewrote this. */
  updatedAt: string;
  models: Model[];
  entries: PolicyEntry[];
  /** Weight on cost in the utility score. */
  lambdaCost: number;
  /** Weight on the probability of missing the latency budget. */
  lambdaLatency: number;
}

/**
 * The fleet and table from PRD 4.2 and 4.4, as shipped defaults.
 *
 * Quality numbers are placeholders on the scale the eval harness uses, and the
 * harness overwrites them. They are here so the router has something to score
 * with before the first eval run, not because they are measurements.
 */
export const DEFAULT_POLICY: RoutingPolicy = {
  version: '1.0.0',
  updatedAt: '2026-01-01',
  lambdaCost: 0.004,
  lambdaLatency: 0.35,
  models: [
    {
      id: 'local-3b',
      vendor: 'open',
      family: 'open-small',
      paramsB: 3,
      placement: 'on_device',
      centsPerKiloToken: 0,
      latencyMsP50: 35,
      latencyMsP95: 90,
      quality: { 'intent.classify': 0.94, 'ink.semantic': 0.78 },
      deterministic: true,
      contextTokens: 8_000,
    },
    {
      id: 'server-8b',
      vendor: 'open',
      family: 'open-small',
      paramsB: 8,
      placement: 'self_hosted',
      centsPerKiloToken: 0.008,
      latencyMsP50: 90,
      latencyMsP95: 260,
      quality: {
        'intent.classify': 0.96,
        'ink.semantic': 0.86,
        'summarize.bulk': 0.82,
      },
      deterministic: true,
      contextTokens: 32_000,
    },
    {
      id: 'qwen-coder-32b',
      vendor: 'open',
      family: 'open-coder',
      paramsB: 32,
      placement: 'self_hosted',
      centsPerKiloToken: 0.04,
      latencyMsP50: 420,
      latencyMsP95: 1_100,
      quality: {
        'sql.generate': 0.88,
        'quant.codegen': 0.84,
        'doc.extract': 0.85,
        'ink.semantic': 0.9,
        'summarize.bulk': 0.88,
      },
      deterministic: true,
      contextTokens: 128_000,
    },
    {
      id: 'open-70b',
      vendor: 'open',
      family: 'open-large',
      paramsB: 70,
      placement: 'self_hosted',
      centsPerKiloToken: 0.09,
      latencyMsP50: 900,
      latencyMsP95: 2_400,
      quality: {
        'plan.decompose': 0.82,
        'synthesis.final': 0.84,
        'critique.redteam': 0.8,
        'doc.extract': 0.88,
        'sql.generate': 0.9,
        'quant.codegen': 0.87,
      },
      deterministic: true,
      contextTokens: 128_000,
    },
    {
      id: 'frontier-a',
      vendor: 'vendor-a',
      family: 'a-reasoning',
      placement: 'vendor',
      centsPerKiloToken: 0.9,
      latencyMsP50: 1_800,
      latencyMsP95: 6_000,
      quality: {
        'sql.generate': 0.96,
        'quant.codegen': 0.95,
        'doc.extract': 0.96,
        'doc.deep_read': 0.95,
        'sentiment.subtext': 0.93,
        'plan.decompose': 0.94,
        'synthesis.final': 0.95,
        'critique.redteam': 0.93,
      },
      deterministic: true,
      contextTokens: 400_000,
    },
    {
      id: 'frontier-b',
      vendor: 'vendor-b',
      family: 'b-core',
      placement: 'vendor',
      centsPerKiloToken: 1.1,
      latencyMsP50: 2_100,
      latencyMsP95: 6_500,
      quality: {
        'doc.deep_read': 0.94,
        'synthesis.final': 0.94,
        // The Critic runs on a different vendor than the author (Appendix C.5),
        // so a second frontier vendor is not redundancy, it is a requirement.
        'critique.redteam': 0.94,
        'plan.decompose': 0.93,
      },
      deterministic: true,
      contextTokens: 300_000,
    },
  ],
  entries: [
    { taskClass: 'intent.classify', latencySloMs: 120, primary: ['local-3b'], fallback: ['server-8b'] },
    {
      taskClass: 'ink.semantic',
      latencySloMs: 400,
      primary: ['local-3b', 'server-8b'],
      fallback: ['qwen-coder-32b'],
      escalateBelowConfidence: 0.7,
    },
    {
      taskClass: 'sql.generate',
      latencySloMs: 800,
      primary: ['qwen-coder-32b'],
      fallback: ['frontier-a'],
      escalateAfterFailures: 2,
    },
    {
      taskClass: 'quant.codegen',
      latencySloMs: 4_000,
      primary: ['qwen-coder-32b'],
      fallback: ['frontier-a'],
      escalateAfterFailures: 1,
    },
    {
      taskClass: 'doc.extract',
      latencySloMs: 3_000,
      primary: ['qwen-coder-32b'],
      fallback: ['frontier-a'],
      escalateAfterFailures: 1,
    },
    {
      taskClass: 'doc.deep_read',
      latencySloMs: 25_000,
      primary: ['frontier-a'],
      fallback: [],
      alwaysEscalate: true,
    },
    {
      taskClass: 'sentiment.subtext',
      latencySloMs: 20_000,
      primary: ['frontier-a'],
      fallback: ['frontier-b'],
      alwaysEscalate: true,
    },
    { taskClass: 'plan.decompose', latencySloMs: 6_000, primary: ['frontier-a'], fallback: ['open-70b'] },
    { taskClass: 'synthesis.final', latencySloMs: 12_000, primary: ['frontier-a'], fallback: ['open-70b'] },
    { taskClass: 'critique.redteam', latencySloMs: 15_000, primary: ['frontier-b'], fallback: ['open-70b'] },
    { taskClass: 'summarize.bulk', latencySloMs: 6_000, primary: ['server-8b'], fallback: ['qwen-coder-32b'] },
    { taskClass: 'embed', latencySloMs: 500, primary: ['server-8b'], fallback: [] },
    { taskClass: 'asr', latencySloMs: 10_000, primary: ['server-8b'], fallback: [] },
  ],
};

export function entryFor(policy: RoutingPolicy, taskClass: TaskClass): PolicyEntry | undefined {
  return policy.entries.find((e) => e.taskClass === taskClass);
}

export function modelById(policy: RoutingPolicy, id: string): Model | undefined {
  return policy.models.find((m) => m.id === id);
}
