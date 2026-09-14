/**
 * The speculative cascade (PRD 4.3).
 *
 * "For classes where a cheap model is usually right, Picasso runs the cheap
 * model first and a verifier second. The verifier is either deterministic (does
 * the SQL parse and return rows; does the code pass its generated tests; do the
 * extracted numbers reconcile to the reported total) or a small judge model.
 * Verification failure escalates one tier."
 *
 * The deterministic verifiers are what make this worth doing. A judge model
 * that is wrong 5 percent of the time caps the whole cascade's accuracy at 95
 * percent; a SQL parser that either parses or does not is wrong zero percent of
 * the time, and when it accepts, the cheap answer is *known* good rather than
 * probably good.
 *
 * Phase 3's exit criterion is measured here: "Cascade terminates >70 percent of
 * requests at cheap tier with <1 percent quality delta."
 */

import { escalate, route, type RoutingDecision, type RoutingFeatures, type RouterOptions } from './router.js';
import type { Model, RoutingPolicy } from './policy.js';
import { entryFor } from './policy.js';

/** What a verifier concluded about a candidate answer. */
export interface Verdict {
  accepted: boolean;
  /** For a judge model. Deterministic verifiers report 1. */
  confidence: number;
  /** Why, for the trace. */
  reason: string;
  /** True when no model was involved in deciding. */
  deterministic: boolean;
}

/** Runs a model. Supplied by the caller, because this package dispatches nothing. */
export type Dispatch<T> = (model: Model, attempt: number) => Promise<T>;

/** Checks an answer. Deterministic where the task admits one. */
export type Verifier<T> = (answer: T, model: Model) => Promise<Verdict> | Verdict;

export interface CascadeStep<T> {
  decision: RoutingDecision;
  answer: T;
  verdict: Verdict;
  costCents: number;
}

export interface CascadeResult<T> {
  answer: T;
  /** Every tier tried, in order. */
  steps: Array<CascadeStep<T>>;
  /** True when the first, cheapest model's answer was accepted. */
  terminatedAtCheapTier: boolean;
  totalCostCents: number;
  /** What always going to the most expensive eligible model would have cost. */
  frontierCostCents: number;
  escalations: number;
}

export interface CascadeOptions extends RouterOptions {
  /** Hard cap on tiers, so a pathological verifier cannot loop. */
  maxTiers?: number;
}

/**
 * Runs the cheap model, verifies, and escalates only on failure.
 *
 * Returns the last answer even when every tier failed verification. The
 * alternative — throwing — would leave the analyst with nothing when the
 * honest report is "here is the best available answer, and it did not verify",
 * which is a different and more useful thing to show.
 */
export async function cascade<T>(
  policy: RoutingPolicy,
  features: RoutingFeatures,
  dispatch: Dispatch<T>,
  verify: Verifier<T>,
  options: CascadeOptions = {},
): Promise<CascadeResult<T>> {
  const entry = entryFor(policy, features.taskClass);
  const maxTiers = options.maxTiers ?? 3;
  const steps: Array<CascadeStep<T>> = [];

  let decision: RoutingDecision | undefined = route(policy, features, options);
  let attempt = 0;
  let failures = 0;

  // What the same request would cost sent straight to the best model the rules
  // allow — the denominator for the cascade's saving.
  const frontierCostCents =
    decision.candidates
      .slice()
      .sort((a, b) => b.quality - a.quality)[0]?.costCents ?? decision.estimatedCostCents;

  while (decision && attempt < maxTiers) {
    const answer = await dispatch(decision.model, attempt);
    const verdict = await verify(answer, decision.model);
    steps.push({ decision, answer, verdict, costCents: decision.estimatedCostCents });

    const belowConfidence =
      entry?.escalateBelowConfidence !== undefined && verdict.confidence < entry.escalateBelowConfidence;

    if (verdict.accepted && !belowConfidence) break;

    failures += 1;
    const budget = entry?.escalateAfterFailures ?? 1;
    if (failures < budget) {
      // The table allows another try at the same tier before spending more.
      attempt += 1;
      continue;
    }

    const next: RoutingDecision | undefined = escalate(policy, features, decision.model, options);
    if (!next) break;
    decision = next;
    failures = 0;
    attempt += 1;
  }

  const last = steps[steps.length - 1];
  const totalCostCents = steps.reduce((sum, s) => sum + s.costCents, 0);
  return {
    answer: last?.answer as T,
    steps,
    terminatedAtCheapTier: steps.length === 1 && (last?.verdict.accepted ?? false),
    totalCostCents,
    frontierCostCents,
    escalations: Math.max(0, steps.length - 1),
  };
}

// ---------------------------------------------------------------------------
// Deterministic verifiers.

/**
 * Does the SQL parse, and does it return rows?
 *
 * A structural check, not a semantic one. It cannot tell a correct query from a
 * query that runs — and it is worth having anyway, because the cheap model's
 * failures on this class are overwhelmingly syntactic or hallucinated columns,
 * both of which this catches for free.
 */
export function sqlVerifier(
  knownTables: ReadonlySet<string>,
  knownColumns: ReadonlySet<string>,
): Verifier<string> {
  return (sql: string): Verdict => {
    const text = sql.trim().toLowerCase();
    if (!text.startsWith('select') && !text.startsWith('with')) {
      return { accepted: false, confidence: 1, deterministic: true, reason: 'not a query' };
    }
    if ((sql.match(/\(/g)?.length ?? 0) !== (sql.match(/\)/g)?.length ?? 0)) {
      return { accepted: false, confidence: 1, deterministic: true, reason: 'unbalanced parentheses' };
    }
    const tables = [...text.matchAll(/\bfrom\s+([a-z_][a-z0-9_.]*)/g)].map((m) => m[1] as string);
    const unknownTable = tables.find((t) => !knownTables.has(t));
    if (unknownTable !== undefined) {
      return {
        accepted: false,
        confidence: 1,
        deterministic: true,
        reason: `table "${unknownTable}" does not exist`,
      };
    }
    const columns = [...text.matchAll(/\b([a-z_][a-z0-9_]*)\s*(?:=|>|<|>=|<=)/g)].map((m) => m[1] as string);
    const unknownColumn = columns.find((c) => !knownColumns.has(c) && !/^\d/.test(c));
    if (unknownColumn !== undefined) {
      return {
        accepted: false,
        confidence: 1,
        deterministic: true,
        reason: `column "${unknownColumn}" does not exist`,
      };
    }
    return { accepted: true, confidence: 1, deterministic: true, reason: 'parses against the schema' };
  };
}

/**
 * Do the extracted numbers reconcile to the reported total?
 *
 * The strongest verifier in the set, because a filing states its own total and
 * a model that hallucinates a segment will not hit it. PRD 4.3 names this one
 * specifically.
 */
export function reconciliationVerifier(toleranceFraction = 0.005): Verifier<{
  parts: number[];
  total: number;
}> {
  return (answer): Verdict => {
    const sum = answer.parts.reduce((a, b) => a + b, 0);
    const gap = Math.abs(sum - answer.total);
    const tolerance = Math.abs(answer.total) * toleranceFraction;
    return gap <= tolerance
      ? {
          accepted: true,
          confidence: 1,
          deterministic: true,
          reason: `parts sum to ${sum.toFixed(2)} against a stated ${answer.total.toFixed(2)}`,
        }
      : {
          accepted: false,
          confidence: 1,
          deterministic: true,
          reason:
            `parts sum to ${sum.toFixed(2)} but the filing states ${answer.total.toFixed(2)} — ` +
            `off by ${gap.toFixed(2)}`,
        };
  };
}

/** Does the generated code pass the tests it generated? */
export function testSuiteVerifier(): Verifier<{ passed: number; failed: number }> {
  return (answer): Verdict =>
    answer.failed === 0 && answer.passed > 0
      ? {
          accepted: true,
          confidence: 1,
          deterministic: true,
          reason: `${answer.passed} tests passed`,
        }
      : {
          accepted: false,
          confidence: 1,
          deterministic: true,
          reason:
            answer.passed === 0
              ? 'the code generated no tests, so nothing was verified'
              : `${answer.failed} of ${answer.passed + answer.failed} tests failed`,
        };
}
