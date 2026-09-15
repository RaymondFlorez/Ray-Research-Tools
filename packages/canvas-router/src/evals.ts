/**
 * The eval harness (PRD 4.7).
 *
 * "A golden set per task class, built from real analyst sessions with
 * human-labeled outcomes: 400 extraction items against known filings, 250
 * codegen tasks with hidden tests, 180 subtext items scored by two analysts,
 * 300 SQL tasks with reference results. Every routing policy change and model
 * version bump runs the harness before promotion."
 *
 * This closes the loop `policy.ts` asserts in its first paragraph: the routing
 * table "lives in a versioned routing policy document that the eval harness
 * rewrites", and until now nothing rewrote it. `rewrite()` is that function.
 *
 * Two things it refuses to do, both of which would make the loop worse than
 * having no loop:
 *
 * **It will not write a quality number from a handful of items.** A model
 * scored on six extraction tasks has a standard error of about 0.2, so
 * promoting it over a rival on that basis is a coin flip wearing a decimal
 * point. Below `MIN_ITEMS` the existing number is left alone and the reason is
 * recorded.
 *
 * **It will not report a score above the ceiling its labels support.** The
 * subtext set is "scored by two analysts", and where two humans disagree there
 * is no single right answer for a model to find. If the raters agree 72
 * percent of the time, a model scoring 0.85 against one rater's labels is
 * partly measuring which rater it happened to be graded against.
 * `labelCeiling` is carried on the set and reported next to every score drawn
 * from it, because a quality table that shows 0.85 and 0.93 side by side
 * implies a comparison the labels cannot support.
 */

import type { Model, RoutingPolicy, TaskClass } from './policy.js';

export interface GoldenItem {
  id: string;
  /** What the model is asked. Opaque here; the scorer understands it. */
  input: unknown;
  /** The human-labeled outcome, or the reference result. */
  expected: unknown;
  /** Present where two raters labeled the item. */
  secondLabel?: unknown;
}

export type Scorer = (answer: unknown, item: GoldenItem) => number;

export interface GoldenSet {
  taskClass: TaskClass;
  version: string;
  items: GoldenItem[];
  /** 0 to 1 per item. Binary for hidden tests, graded for subtext. */
  score: Scorer;
  /**
   * How often two raters agreed, where the set is double-labeled.
   *
   * Undefined for sets with a mechanical ground truth — a SQL reference result
   * or a hidden test suite has no rater disagreement to measure.
   */
  labelCeiling?: number;
}

/** Below this many scored items, a measured quality number is noise. */
export const MIN_ITEMS = 30;

/**
 * Agreement between two raters on a double-labeled set.
 *
 * Raw agreement rather than a kappa, and the choice is worth stating: kappa
 * corrects for chance agreement, which is the right statistic for judging
 * whether two raters are doing better than guessing. That is not the question
 * here. The question is what fraction of items have an answer a model could
 * get right, and that is raw agreement.
 */
export function labelAgreement(set: GoldenSet, equal = Object.is): number | undefined {
  const doubled = set.items.filter((item) => item.secondLabel !== undefined);
  if (doubled.length === 0) return undefined;
  const agreed = doubled.filter((item) => equal(item.expected, item.secondLabel)).length;
  return agreed / doubled.length;
}

export type Answer = (model: Model, item: GoldenItem) => Promise<unknown> | unknown;

export interface ModelScore {
  modelId: string;
  taskClass: TaskClass;
  items: number;
  /** Mean per-item score. */
  quality: number;
  /** Standard error of that mean. */
  standardError: number;
  /** The set's label ceiling, where it has one. */
  labelCeiling?: number;
  /** Set when the score cannot be compared with others at face value. */
  caveat?: string;
}

export interface EvalRun {
  at: string;
  setVersions: Record<string, string>;
  scores: ModelScore[];
}

export async function runEval(
  models: readonly Model[],
  sets: readonly GoldenSet[],
  answer: Answer,
  at = new Date().toISOString(),
): Promise<EvalRun> {
  const scores: ModelScore[] = [];
  const setVersions: Record<string, string> = {};

  for (const set of sets) {
    setVersions[set.taskClass] = set.version;
    const ceiling = set.labelCeiling ?? labelAgreement(set);
    for (const model of models) {
      const values: number[] = [];
      for (const item of set.items) {
        values.push(set.score(await answer(model, item), item));
      }
      const quality = values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
      const variance =
        values.length < 2
          ? Number.NaN
          : values.reduce((total, v) => total + (v - quality) ** 2, 0) / (values.length - 1);
      const standardError = Number.isFinite(variance) ? Math.sqrt(variance / values.length) : Number.NaN;

      const caveats: string[] = [];
      if (values.length < MIN_ITEMS) {
        caveats.push(`${values.length} items is below the ${MIN_ITEMS} needed for a usable number`);
      }
      if (ceiling !== undefined && quality > ceiling) {
        caveats.push(
          `scored ${quality.toFixed(2)} against labels whose two raters agree only ${ceiling.toFixed(2)} of the time; ` +
            'the excess is not skill the labels can see',
        );
      }

      scores.push({
        modelId: model.id,
        taskClass: set.taskClass,
        items: values.length,
        quality,
        standardError,
        ...(ceiling !== undefined ? { labelCeiling: ceiling } : {}),
        ...(caveats.length > 0 ? { caveat: caveats.join('; ') } : {}),
      });
    }
  }

  return { at, setVersions, scores };
}

export interface QualityChange {
  modelId: string;
  taskClass: TaskClass;
  from?: number;
  to: number;
  delta: number;
}

export interface Rewrite {
  policy: RoutingPolicy;
  changes: QualityChange[];
  /** Scores that were measured but not written, and why. */
  skipped: Array<{ modelId: string; taskClass: TaskClass; reason: string }>;
}

function bumpMinor(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${Number.parseInt(minor, 10) + 1}.0`;
}

/**
 * Write measured quality back into the policy.
 *
 * Returns a new policy rather than mutating one. A routing table that changes
 * under a dispatcher mid-request is a table nobody can reason about, and the
 * version bump is what lets a trace say which table produced a decision.
 */
export function rewrite(policy: RoutingPolicy, run: EvalRun): Rewrite {
  const changes: QualityChange[] = [];
  const skipped: Rewrite['skipped'] = [];

  const models = policy.models.map((model) => ({ ...model, quality: { ...model.quality } }));
  const byId = new Map(models.map((m) => [m.id, m]));

  for (const score of run.scores) {
    const model = byId.get(score.modelId);
    if (!model) {
      skipped.push({ modelId: score.modelId, taskClass: score.taskClass, reason: 'not in the policy' });
      continue;
    }
    if (score.items < MIN_ITEMS) {
      skipped.push({
        modelId: score.modelId,
        taskClass: score.taskClass,
        reason: `${score.items} items is below the ${MIN_ITEMS} the harness will write from`,
      });
      continue;
    }
    if (!Number.isFinite(score.quality)) {
      skipped.push({ modelId: score.modelId, taskClass: score.taskClass, reason: 'no finite score' });
      continue;
    }

    const from = model.quality[score.taskClass];
    model.quality[score.taskClass] = score.quality;
    changes.push({
      modelId: score.modelId,
      taskClass: score.taskClass,
      ...(from !== undefined ? { from } : {}),
      to: score.quality,
      delta: from === undefined ? Number.NaN : score.quality - from,
    });
  }

  return {
    policy: {
      ...policy,
      version: bumpMinor(policy.version),
      updatedAt: run.at.slice(0, 10),
      models,
    },
    changes,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Determinism and staleness attribution
// ---------------------------------------------------------------------------

/**
 * "Any node feeding a compute path pins model version, temperature 0, and
 * seed. Model version changes mark those nodes stale with an explicit reason
 * so the analyst knows a number moved because the model changed, not because
 * the market did."
 *
 * The second sentence is the feature. Marking a node stale is easy; marking it
 * stale with a reason the analyst can read *at the moment the number moves* is
 * what separates a system they can trust from one where every recomputation is
 * a small mystery.
 */
export interface PinnedDispatch {
  nodeId: string;
  modelId: string;
  /** The exact version the node's last value was computed with. */
  modelVersion: string;
  temperature: number;
  seed: number;
}

export class NotDeterministic extends Error {
  constructor(readonly nodeId: string, reason: string) {
    super(`${nodeId} feeds a compute path and ${reason}`);
    this.name = 'NotDeterministic';
  }
}

/** A node feeding compute must pin all three. Any one missing is not a pin. */
export function assertPinned(dispatch: PinnedDispatch): void {
  if (dispatch.modelVersion.trim() === '') {
    throw new NotDeterministic(dispatch.nodeId, 'does not pin a model version');
  }
  if (dispatch.temperature !== 0) {
    throw new NotDeterministic(dispatch.nodeId, `runs at temperature ${dispatch.temperature}, not 0`);
  }
  if (!Number.isInteger(dispatch.seed)) {
    throw new NotDeterministic(dispatch.nodeId, 'does not pin an integer seed');
  }
}

export interface StaleByModelChange {
  nodeId: string;
  modelId: string;
  was: string;
  now: string;
  /** What the analyst reads on the stale badge. */
  reason: string;
}

export function staleForModelChange(
  dispatches: readonly PinnedDispatch[],
  modelId: string,
  newVersion: string,
): StaleByModelChange[] {
  return dispatches
    .filter((d) => d.modelId === modelId && d.modelVersion !== newVersion)
    .map((d) => ({
      nodeId: d.nodeId,
      modelId,
      was: d.modelVersion,
      now: newVersion,
      reason:
        `${modelId} moved from ${d.modelVersion} to ${newVersion}. If this number changes on recompute, ` +
        'the model changed, not the market.',
    }));
}
