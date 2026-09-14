/**
 * The router (PRD 4.3).
 *
 * `Request → Feature Extraction → Policy Match → Budget Check → Dispatch →
 * Verify → Trace`
 *
 * **Rules first, scores second, and the order is load-bearing.** PRD 4.3: "Hard
 * rules run first and cannot be overridden by a score." A score is a number
 * about expected quality per cent; a rule is a statement about where data is
 * allowed to go. If a score could outvote a rule then a sufficiently good
 * frontier model would eventually be worth sending positions to, which is
 * exactly the reasoning the rule exists to forbid.
 */

import {
  entryFor,
  modelById,
  type Model,
  type Placement,
  type RoutingPolicy,
  type TaskClass,
} from './policy.js';

/** PRD 4.3's routing vector, verbatim. */
export interface RoutingFeatures {
  taskClass: TaskClass;
  inputTokens: number;
  expectedOutputTokens: number;
  modalities: Array<'text' | 'image' | 'audio' | 'table' | 'code'>;
  toolsRequired: string[];
  /** The analyst pressed "high rigor", or the node is thesis-critical. */
  rigorFlag: boolean;
  dataSensitivity: 'public' | 'licensed' | 'positions' | 'mnpi_risk';
  costCeilingCents: number;
  latencyBudgetMs: number;
  /** This output feeds a compute node, so it must be reproducible. */
  determinismRequired: boolean;
  priorFailures: FailureRecord[];
}

export interface FailureRecord {
  modelId: string;
  reason: 'verification' | 'timeout' | 'error' | 'refusal';
  at: number;
}

export interface Candidate {
  model: Model;
  score: number;
  quality: number;
  costCents: number;
  latencyRisk: number;
}

export interface RoutingDecision {
  model: Model;
  /** Why this model, in the order the reasons applied. */
  reasons: string[];
  /** Candidates that a hard rule removed, with the rule that removed them. */
  excluded: Array<{ modelId: string; rule: string }>;
  candidates: Candidate[];
  estimatedCostCents: number;
  /** Set when determinism was required, so the trace can reproduce the call. */
  pinned?: { temperature: 0; seed: number };
  policyVersion: string;
}

export class NoEligibleModel extends Error {
  constructor(
    readonly features: RoutingFeatures,
    readonly excluded: Array<{ modelId: string; rule: string }>,
  ) {
    super(
      `no model can serve ${features.taskClass} under these constraints. ` +
        excluded.map((e) => `${e.modelId}: ${e.rule}`).join('; '),
    );
    this.name = 'NoEligibleModel';
  }
}

export interface RouterOptions {
  /** An org policy can pin the whole tenant to a vendor set (PRD 4.3). */
  allowedVendors?: readonly string[];
  /** Seed for deterministic dispatch. Recorded on the decision. */
  seed?: number;
}

/** Placements a given sensitivity may use. */
function allowedPlacements(sensitivity: RoutingFeatures['dataSensitivity']): Placement[] {
  // "Portfolio positions and any document flagged as potentially non-public
  // never leave the tenant boundary." On-device is inside the tenant boundary
  // by construction — the data never moved at all.
  return sensitivity === 'positions' || sensitivity === 'mnpi_risk'
    ? ['on_device', 'self_hosted']
    : ['on_device', 'self_hosted', 'vendor'];
}

function estimateCost(model: Model, features: RoutingFeatures): number {
  const kilotokens = (features.inputTokens + features.expectedOutputTokens) / 1000;
  return model.centsPerKiloToken * kilotokens;
}

/**
 * Probability the model misses the latency budget.
 *
 * Interpolated between the measured p50 and p95 rather than assumed normal: the
 * latency distribution of a model behind a queue is not symmetric, and the two
 * quantiles are what is actually observed.
 */
function latencyRisk(model: Model, budgetMs: number): number {
  if (budgetMs >= model.latencyMsP95) return 0.05 * Math.max(0, 1 - (budgetMs - model.latencyMsP95) / budgetMs);
  if (budgetMs <= model.latencyMsP50) return 1 - 0.5 * (budgetMs / Math.max(1, model.latencyMsP50));
  const span = model.latencyMsP95 - model.latencyMsP50;
  const position = (budgetMs - model.latencyMsP50) / Math.max(1, span);
  return 0.5 - 0.45 * position;
}

/**
 * Chooses a model.
 *
 * Hard rules first — they remove candidates and record why. Then the
 * expected-utility score from PRD 4.3:
 *
 * ```
 * score(m) = quality(m, taskClass) − λ_cost · cost(m, tokens) − λ_lat · P(latency > budget)
 * ```
 */
export function route(
  policy: RoutingPolicy,
  features: RoutingFeatures,
  options: RouterOptions = {},
): RoutingDecision {
  const entry = entryFor(policy, features.taskClass);
  const reasons: string[] = [];
  const excluded: Array<{ modelId: string; rule: string }> = [];

  const placements = allowedPlacements(features.dataSensitivity);
  const failedOn = new Set(features.priorFailures.map((f) => f.modelId));

  let eligible = policy.models.filter((model) => {
    if (model.quality[features.taskClass] === undefined) {
      excluded.push({ modelId: model.id, rule: `not evaluated on ${features.taskClass}` });
      return false;
    }
    if (!placements.includes(model.placement)) {
      excluded.push({
        modelId: model.id,
        rule: `${features.dataSensitivity} data may not reach a ${model.placement} model`,
      });
      return false;
    }
    if (options.allowedVendors && !options.allowedVendors.includes(model.vendor)) {
      excluded.push({ modelId: model.id, rule: `vendor ${model.vendor} is not in the org's allowed set` });
      return false;
    }
    if (features.determinismRequired && !model.deterministic) {
      excluded.push({ modelId: model.id, rule: 'cannot be pinned to a version and temperature zero' });
      return false;
    }
    if (model.contextTokens < features.inputTokens) {
      excluded.push({ modelId: model.id, rule: `context window is ${model.contextTokens} tokens` });
      return false;
    }
    if (failedOn.has(model.id)) {
      excluded.push({ modelId: model.id, rule: 'this request already failed on it' });
      return false;
    }
    return true;
  });

  if (placements.length === 2) {
    reasons.push(`${features.dataSensitivity} data stays inside the tenant boundary`);
  }
  if (features.determinismRequired) {
    reasons.push('output feeds a compute node, so the call is pinned and seeded');
  }

  // The budget is a hard rule too, but only if something remains under it.
  const affordable = eligible.filter((m) => estimateCost(m, features) <= features.costCeilingCents);
  if (affordable.length > 0) {
    for (const model of eligible) {
      if (!affordable.includes(model)) {
        excluded.push({
          modelId: model.id,
          rule: `would cost ${estimateCost(model, features).toFixed(3)}c against a ceiling of ${features.costCeilingCents}c`,
        });
      }
    }
    eligible = affordable;
  } else if (eligible.length > 0) {
    // Nothing fits the budget. The orchestrator surfaces an approval prompt
    // rather than silently degrading, so the router still names the model it
    // would use (PRD 4.3's "this node wants $0.42 more, approve?").
    reasons.push('over budget — dispatch requires approval');
  }

  if (eligible.length === 0) throw new NoEligibleModel(features, excluded);

  const candidates: Candidate[] = eligible
    .map((model) => {
      const quality = model.quality[features.taskClass] ?? 0;
      const costCents = estimateCost(model, features);
      const risk = latencyRisk(model, features.latencyBudgetMs);
      return {
        model,
        quality,
        costCents,
        latencyRisk: risk,
        score: quality - policy.lambdaCost * costCents - policy.lambdaLatency * risk,
      };
    })
    .sort((a, b) => b.score - a.score);

  let chosen = candidates[0] as Candidate;

  // Rigor and always-escalate classes take the best *quality*, not the best
  // utility. An analyst who pressed "high rigor" is explicitly buying quality
  // with money, and a score that trades it back is answering a different
  // question than the one they asked.
  if (features.rigorFlag || entry?.alwaysEscalate) {
    const best = [...candidates].sort((a, b) => b.quality - a.quality)[0] as Candidate;
    if (best.model.id !== chosen.model.id) {
      reasons.push(
        features.rigorFlag
          ? 'high rigor requested, so quality outranks cost'
          : `${features.taskClass} always goes to the top tier`,
      );
      chosen = best;
    }
  }

  reasons.push(
    `${chosen.model.id}: quality ${chosen.quality.toFixed(2)}, ` +
      `${chosen.costCents.toFixed(3)}c, ${(chosen.latencyRisk * 100).toFixed(0)}% chance of ` +
      `missing the ${features.latencyBudgetMs}ms budget`,
  );

  return {
    model: chosen.model,
    reasons,
    excluded,
    candidates,
    estimatedCostCents: chosen.costCents,
    ...(features.determinismRequired ? { pinned: { temperature: 0 as const, seed: options.seed ?? 0 } } : {}),
    policyVersion: policy.version,
  };
}

/**
 * The next tier up, for an escalation.
 *
 * The *ladder* comes from the policy table, not from the score. PRD 4.2 names a
 * fallback per class — `sql.generate` escalates to a frontier model — and a
 * router that re-scored from scratch would instead pick whatever ranked next,
 * which on a tight latency budget is a cheaper self-hosted model that is no
 * more likely to succeed. Escalation means *up*, and the table is what says
 * which way that is.
 *
 * The score still chooses *within* the fallback tier when it lists several.
 */
export function escalate(
  policy: RoutingPolicy,
  features: RoutingFeatures,
  from: Model,
  options: RouterOptions = {},
): RoutingDecision | undefined {
  const entry = entryFor(policy, features.taskClass);
  const withFailure: RoutingFeatures = {
    ...features,
    priorFailures: [...features.priorFailures, { modelId: from.id, reason: 'verification', at: 0 }],
  };

  const ladder = entry?.fallback ?? [];
  if (ladder.length > 0) {
    // Restrict to the named tier, then let the usual rules and score run over
    // it. A fallback that a hard rule forbids is simply not available, which is
    // the right outcome rather than a reason to reach past the ladder.
    const tier: RoutingPolicy = {
      ...policy,
      models: policy.models.filter((m) => ladder.includes(m.id)),
    };
    try {
      const decision = route(tier, withFailure, options);
      return {
        ...decision,
        reasons: [`escalated from ${from.id} to the fallback tier named by the policy`, ...decision.reasons],
      };
    } catch {
      // The named fallback cannot serve this request. Fall through and see
      // whether anything else can.
    }
  }

  try {
    return route(policy, withFailure, options);
  } catch {
    // Nothing better is allowed to see this data, which is an answer rather
    // than an error: the tier above was excluded by a rule, not by a score.
    return undefined;
  }
}

export { modelById };
