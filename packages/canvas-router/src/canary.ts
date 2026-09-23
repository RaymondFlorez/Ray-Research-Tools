/**
 * The canary (PRD 4.7).
 *
 * > **Canary.** New model versions take 5 percent of traffic in shadow
 * > (dispatched, result compared, not shown) before promotion. Regression on
 * > any task class above 2 percent blocks the promotion.
 *
 * Four decisions, none of them restatements.
 *
 * ## The sample is derived, not drawn
 *
 * `Math.random() < 0.05` gives the right share and nothing else. A trace store
 * whose whole purpose is that a dispatch can be replayed cannot say *why* a
 * given request was shadowed, two runs of the same session shadow different
 * requests, and a test for the share has to average over thousands of draws to
 * see anything. Here the decision is a function of the request id and the
 * candidate version: the same request is shadowed on every replay, a different
 * candidate samples a different 5 percent, and the share is a property of the
 * hash rather than of the number of trials.
 *
 * ## "Not shown" is a type, not a convention
 *
 * `shadow()` hands back the incumbent's answer and a record. There is no field
 * on the result holding the candidate's output, so a caller cannot show it by
 * mistake, and the comparison the PRD asks for happens here rather than in
 * whatever code forgot. The candidate's failure is a recorded difference and
 * never an error the analyst sees: a model being evaluated cannot fail a
 * request that was not routed to it.
 *
 * ## Per class, and thin evidence blocks
 *
 * "Regression on any task class above 2 percent" is a floor over classes, not
 * an average: a candidate that gains three points on bulk summarization and
 * loses four on codegen improves on aggregate and is exactly the promotion the
 * rule exists to stop. And a class the shadow barely covered does not clear
 * the gate by having no evidence against the candidate. Promotion is the
 * action that needs justifying, so silence blocks it.
 *
 * ## The bill is reported
 *
 * A shadowed request is dispatched twice. Five percent of traffic at double
 * cost is a five percent cost increase, which is worth knowing before it shows
 * up as an unexplained line — so the report carries what the shadow spent.
 */

import { hash } from '@picasso/canvas-core';
import type { TaskClass } from './policy.js';

/** PRD 4.7: "New model versions take 5 percent of traffic in shadow." */
export const CANARY_SHARE = 0.05;

/** PRD 4.7: "Regression on any task class above 2 percent blocks the promotion." */
export const REGRESSION_LIMIT = 0.02;

/**
 * Minimum shadow dispatches before a class can clear the gate.
 *
 * `evals.ts` refuses to write a quality number from fewer than 30 items for
 * the same reason, and the arithmetic has not changed in between: a difference
 * measured on six dispatches has a standard error several times the two-point
 * threshold it is being compared against.
 */
export const MIN_SHADOW_PER_CLASS = 30;

export interface CanaryPlan {
  modelId: string;
  /** The version in production. */
  incumbent: string;
  /** The version under evaluation. */
  candidate: string;
  /** Defaults to `CANARY_SHARE`. */
  share?: number;
}

/**
 * Whether this request is in the shadow sample.
 *
 * Derived from the request id and the candidate version together. Keying on
 * the id alone would shadow the same requests for every candidate forever,
 * which quietly turns a 5 percent sample of traffic into a 5 percent sample of
 * *requests* — the same analysts, the same canvases, the same work, evaluating
 * every model version that ever ships against one slice of the product.
 */
export function inShadow(plan: CanaryPlan, requestId: string): boolean {
  const share = plan.share ?? CANARY_SHARE;
  if (share <= 0) return false;
  if (share >= 1) return true;
  return unitInterval(`${plan.modelId}:${plan.candidate}:${requestId}`) < share;
}

/** A hash mapped into [0, 1), from the first 52 bits so the mantissa holds it exactly. */
function unitInterval(key: string): number {
  const digest = hash(key);
  const hex = digest.length >= 13 ? digest.slice(0, 13) : digest.padEnd(13, '0');
  return Number.parseInt(hex, 16) / 2 ** 52;
}

export interface ShadowRecord {
  requestId: string;
  taskClass: TaskClass;
  modelId: string;
  incumbent: string;
  candidate: string;
  /** The verifier's score for each, on whatever scale the class is scored on. */
  incumbentScore: number;
  candidateScore: number;
  /** What the shadow dispatch cost on top of the request. */
  shadowCostCents: number;
  shadowLatencyMs: number;
  /** Set when the candidate failed outright. Scored zero, never surfaced. */
  candidateError?: string;
  at: number;
}

export interface ShadowOutcome<T> {
  /** What the caller shows. Always the incumbent's, by construction. */
  answer: T;
  /** Absent when the request was not sampled. */
  record?: ShadowRecord;
}

export interface ShadowInput<T> {
  plan: CanaryPlan;
  requestId: string;
  taskClass: TaskClass;
  at: number;
  /** The real dispatch. Its failure is the caller's failure. */
  live: () => Promise<{ answer: T; costCents: number; latencyMs: number }>;
  /** The shadow dispatch. Its failure is a recorded zero. */
  candidate: () => Promise<{ answer: T; costCents: number; latencyMs: number }>;
  /** The verifier, scoring both answers on the same scale. */
  score: (answer: T) => number;
}

/**
 * Dispatch, shadow, compare, return the incumbent's answer.
 *
 * The candidate's answer is scored and dropped. Nothing in the return type can
 * carry it, which is what "not shown" means when the person who has to honour
 * it is a caller written six months later.
 */
export async function shadow<T>(input: ShadowInput<T>): Promise<ShadowOutcome<T>> {
  const live = await input.live();
  if (!inShadow(input.plan, input.requestId)) return { answer: live.answer };

  const base: Omit<ShadowRecord, 'candidateScore' | 'shadowCostCents' | 'shadowLatencyMs'> = {
    requestId: input.requestId,
    taskClass: input.taskClass,
    modelId: input.plan.modelId,
    incumbent: input.plan.incumbent,
    candidate: input.plan.candidate,
    incumbentScore: input.score(live.answer),
    at: input.at,
  };

  try {
    const shadowed = await input.candidate();
    return {
      answer: live.answer,
      record: {
        ...base,
        candidateScore: input.score(shadowed.answer),
        shadowCostCents: shadowed.costCents,
        shadowLatencyMs: shadowed.latencyMs,
      },
    };
  } catch (error) {
    // A model under evaluation cannot fail a request that was not routed to
    // it. It scores zero, which is the strongest thing a failure can say about
    // a candidate, and the caller never learns it happened.
    return {
      answer: live.answer,
      record: {
        ...base,
        candidateScore: 0,
        shadowCostCents: 0,
        shadowLatencyMs: 0,
        candidateError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export interface ClassComparison {
  taskClass: TaskClass;
  dispatches: number;
  incumbentMean: number;
  candidateMean: number;
  /** Positive is a regression: the incumbent scored higher. */
  regression: number;
  candidateErrors: number;
  /** Why this class blocks, or undefined when it does not. */
  blocks?: string;
}

export interface CanaryReport {
  modelId: string;
  incumbent: string;
  candidate: string;
  dispatches: number;
  byClass: ClassComparison[];
  /** Every class compared, sufficiently covered, and within the limit. */
  promote: boolean;
  /** The reasons promotion is blocked, in the order the classes are reported. */
  blockers: string[];
  shadowCostCents: number;
}

/**
 * Compare a candidate against the incumbent, class by class.
 *
 * `classes` is the set the candidate must clear. It is an argument rather than
 * whatever turned up in the records, because a class with no shadow traffic at
 * all is the case the rule most needs to catch: a candidate that was never
 * asked to write SQL has not shown that it can, and reading the covered
 * classes off the records would promote it on the strength of the work it
 * happened to be given.
 */
export function compareCanary(
  plan: CanaryPlan,
  records: readonly ShadowRecord[],
  classes: readonly TaskClass[],
  minPerClass = MIN_SHADOW_PER_CLASS,
): CanaryReport {
  const mine = records.filter(
    (r) =>
      r.modelId === plan.modelId &&
      r.incumbent === plan.incumbent &&
      r.candidate === plan.candidate,
  );

  const byClass: ClassComparison[] = [];
  const blockers: string[] = [];

  for (const taskClass of classes) {
    const rows = mine.filter((r) => r.taskClass === taskClass);
    const dispatches = rows.length;
    const incumbentMean = mean(rows.map((r) => r.incumbentScore));
    const candidateMean = mean(rows.map((r) => r.candidateScore));
    const regression = incumbentMean - candidateMean;
    const comparison: ClassComparison = {
      taskClass,
      dispatches,
      incumbentMean,
      candidateMean,
      regression,
      candidateErrors: rows.filter((r) => r.candidateError !== undefined).length,
    };

    if (dispatches < minPerClass) {
      comparison.blocks =
        `${taskClass}: ${dispatches} shadow dispatches, fewer than the ${minPerClass} ` +
        'needed to measure a two-point difference';
    } else if (regression > REGRESSION_LIMIT) {
      comparison.blocks =
        `${taskClass}: ${plan.candidate} scores ${candidateMean.toFixed(3)} against ` +
        `${incumbentMean.toFixed(3)}, a regression of ${(regression * 100).toFixed(1)} points`;
    }
    if (comparison.blocks) blockers.push(comparison.blocks);
    byClass.push(comparison);
  }

  return {
    modelId: plan.modelId,
    incumbent: plan.incumbent,
    candidate: plan.candidate,
    dispatches: mine.length,
    byClass,
    promote: blockers.length === 0,
    blockers,
    shadowCostCents: mine.reduce((a, r) => a + r.shadowCostCents, 0),
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export class PromotionBlocked extends Error {
  constructor(readonly report: CanaryReport) {
    super(
      `${report.modelId} ${report.candidate} cannot be promoted over ${report.incumbent}: ` +
        report.blockers.join('; '),
    );
    this.name = 'PromotionBlocked';
  }
}

/**
 * The gate itself.
 *
 * Throws rather than returning a boolean, because the caller is a deploy step
 * and the failure mode of a boolean gate is a caller that does not check it.
 */
export function assertPromotable(report: CanaryReport): void {
  if (!report.promote) throw new PromotionBlocked(report);
}
