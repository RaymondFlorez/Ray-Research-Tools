/**
 * The Deep Inquiry `QueryNode` (PRD 5.7).
 *
 * "The `QueryNode` takes an open-ended question and compiles it into an
 * execution plan **before running anything**."
 *
 * The six stages are parse-and-scope, plan, execute, reconcile, critique,
 * synthesize, and four of them already exist: `reconcile` and the `Critic` are
 * in this package, the router picks the models, and `run` in `coordinator.ts`
 * executes a plan as waves. What is missing is the front door — the part that
 * turns a sentence into a plan a person can read and edit before it costs
 * anything.
 *
 * Three rules carry that, and each is stated in the PRD as a refusal:
 *
 * **"Ambiguity produces a disambiguation chip, not a guess."** `scope` returns
 * unresolved entities rather than picking the most likely match. An entity
 * resolver that guesses is right most of the time, which is the problem: the
 * analyst stops checking, and the one time "Micron" resolved to the wrong
 * listing the whole answer is quietly about a different company.
 *
 * **"The plan is shown to the analyst before execution for anything above a
 * cost threshold or flagged high-rigor."** So the plan carries a cost estimate
 * per step, and `needsApproval` is a function of that estimate rather than a
 * flag someone sets.
 *
 * **"Plans are editable: the analyst can delete a step, add a data source, or
 * change a method."** Which means a plan is data, and editing it has to keep
 * it consistent — deleting a step that another step depends on has to do
 * something defined. It prunes the dependents and says which, because silently
 * leaving a step whose input will never arrive produces a run that hangs at a
 * wave boundary with nothing to show for it.
 */

import type { TaskClass } from '@picasso/canvas-router';
import type { AgentRole, PlanStep } from './blackboard.js';

// ---------------------------------------------------------------------------
// 1. Parse and scope
// ---------------------------------------------------------------------------

export type EntityKind = 'instrument' | 'portfolio' | 'index' | 'date' | 'metric';

export interface ResolvedEntity {
  kind: EntityKind;
  /** As written in the question. */
  mention: string;
  /** Canonical id from the reference layer. */
  id: string;
  label: string;
}

export interface Ambiguity {
  kind: EntityKind;
  mention: string;
  /** Every candidate, so the chip can show them. Never pre-selected. */
  candidates: Array<{ id: string; label: string; hint?: string }>;
}

export interface Scope {
  question: string;
  resolved: ResolvedEntity[];
  ambiguous: Ambiguity[];
  /** Nodes the analyst had selected when they asked. */
  selectedNodes: string[];
  ready: boolean;
}

export type Resolver = (
  mention: string,
) => Array<{ kind: EntityKind; id: string; label: string; hint?: string }>;

export interface ScopeInput {
  question: string;
  resolve: Resolver;
  selectedNodes?: readonly string[];
  /** Choices the analyst already made on a previous pass. */
  choices?: Record<string, string>;
}

/**
 * Resolve the mentions in a question, and refuse to guess.
 *
 * A single candidate resolves. Two or more become a chip. Zero is neither: an
 * unrecognized word is almost always an ordinary English word rather than a
 * ticker nobody has heard of, so it is dropped rather than reported as an
 * unresolvable entity that the analyst would then have to dismiss one at a
 * time.
 */
export function scope(input: ScopeInput): Scope {
  const mentions = extractMentions(input.question);
  const resolved: ResolvedEntity[] = [];
  const ambiguous: Ambiguity[] = [];

  for (const mention of mentions) {
    const candidates = input.resolve(mention);
    if (candidates.length === 0) continue;

    const chosen = input.choices?.[mention];
    if (chosen !== undefined) {
      const pick = candidates.find((c) => c.id === chosen);
      if (pick) {
        resolved.push({ kind: pick.kind, mention, id: pick.id, label: pick.label });
        continue;
      }
    }

    if (candidates.length === 1) {
      const only = candidates[0]!;
      resolved.push({ kind: only.kind, mention, id: only.id, label: only.label });
      continue;
    }

    ambiguous.push({
      kind: candidates[0]!.kind,
      mention,
      candidates: candidates.map((c) => ({
        id: c.id,
        label: c.label,
        ...(c.hint !== undefined ? { hint: c.hint } : {}),
      })),
    });
  }

  return {
    question: input.question,
    resolved,
    ambiguous,
    selectedNodes: [...(input.selectedNodes ?? [])],
    ready: ambiguous.length === 0,
  };
}

/**
 * Candidate entity mentions: tickers, quoted phrases, and possessive
 * references to things on the canvas.
 *
 * The determiner stays in the mention. "my portfolio" and "the portfolio" are
 * different references — one is the analyst's book and one is whichever
 * portfolio node is on the canvas — and stripping the possessive down to
 * "portfolio" throws away the only thing that distinguishes them.
 *
 * Both the two-word and three-word forms are offered, because the boundary is
 * not decidable from the text: "my portfolio against 50bp" greedily matches
 * three words, of which the reference is the first two, while "the options
 * book" genuinely is three. Emitting both and letting the reference layer
 * recognize one costs a lookup and removes a guess.
 */
function extractMentions(question: string): string[] {
  const out = new Set<string>();
  for (const match of question.matchAll(
    /"([^"]+)"|\b([A-Z]{1,6})\b|\b((?:my|the)\s+[a-z]+(?:\s+[a-z]+)?)\b/g,
  )) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim();
    if (!value) continue;
    out.add(value);
    if (match[3] !== undefined) {
      const words = value.split(/\s+/);
      if (words.length === 3) out.add(words.slice(0, 2).join(' '));
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// 2. Plan
// ---------------------------------------------------------------------------

export type StepKind = 'retrieval' | 'compute' | 'reasoning';

export interface PlannedStep {
  id: string;
  kind: StepKind;
  description: string;
  agent: AgentRole;
  /** Which model class this step dispatches, where it dispatches one. */
  taskClass?: TaskClass;
  dependsOn: string[];
  estimatedCents: number;
  estimatedMs: number;
  /** The canvas node this step will materialize. */
  materializes?: string;
  /** Method the analyst can change, named so the plan can offer alternatives. */
  method?: string;
  alternatives?: string[];
}

export interface Plan {
  question: string;
  steps: PlannedStep[];
  totalCents: number;
  /** Critical path, not the sum: steps in a wave run together. */
  estimatedMs: number;
  /** True when the plan must be shown before anything runs. */
  needsApproval: boolean;
  approvalReason?: string;
  warnings: string[];
}

/** Above this estimate, the plan is shown before it runs. */
export const APPROVAL_CENTS = 25;

export interface PlanInput {
  scope: Scope;
  steps: readonly PlannedStep[];
  /** The analyst asked for rigor, which shows the plan whatever it costs. */
  highRigor?: boolean;
}

export function plan(input: PlanInput): Plan {
  const steps = [...input.steps];
  const totalCents = steps.reduce((total, s) => total + s.estimatedCents, 0);
  const estimatedMs = criticalPath(steps);
  const warnings: string[] = [];

  if (!input.scope.ready) {
    warnings.push(
      `${input.scope.ambiguous.length} mention(s) are unresolved: ${input.scope.ambiguous
        .map((a) => a.mention)
        .join(', ')}. The plan cannot run until they are chosen.`,
    );
  }

  const missing = steps.filter((s) => s.dependsOn.some((d) => !steps.some((t) => t.id === d)));
  for (const step of missing) {
    warnings.push(`${step.id} depends on a step that is not in the plan`);
  }

  const needsApproval = input.highRigor === true || totalCents > APPROVAL_CENTS;
  return {
    question: input.scope.question,
    steps,
    totalCents,
    estimatedMs,
    needsApproval,
    ...(needsApproval
      ? {
          approvalReason:
            input.highRigor === true
              ? 'flagged high-rigor'
              : `estimated at ${totalCents.toFixed(0)} cents, above the ${APPROVAL_CENTS}-cent threshold`,
        }
      : {}),
    warnings,
  };
}

/**
 * Longest path through the dependency graph.
 *
 * Summing the step durations would be the wrong estimate and wrong in the
 * direction that matters: the worked example's two branches run in parallel,
 * so a sum would quote 40 seconds for a plan that takes 22 and the analyst
 * would decline a plan they should have approved.
 */
export function criticalPath(steps: readonly PlannedStep[]): number {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const longest = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const step = byId.get(id);
    if (!step) return 0;
    visiting.add(id);
    const upstream = step.dependsOn.reduce((worst, d) => Math.max(worst, longest(d)), 0);
    visiting.delete(id);
    const total = upstream + step.estimatedMs;
    memo.set(id, total);
    return total;
  };

  return steps.reduce((worst, step) => Math.max(worst, longest(step.id)), 0);
}

// ---------------------------------------------------------------------------
// Editing a plan
// ---------------------------------------------------------------------------

export interface Edit {
  plan: Plan;
  /** Steps removed because what they depended on is gone. */
  pruned: string[];
  note?: string;
}

/**
 * Delete a step, and everything that can no longer run.
 *
 * Leaving a dependent behind would produce a run that stalls at a wave
 * boundary waiting on an input that will never arrive, with nothing on the
 * canvas to explain why. Pruning and naming what was pruned is the only
 * version of this the analyst can act on.
 */
export function deleteStep(current: Plan, stepId: string, scope: Scope): Edit {
  const dead = new Set([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of current.steps) {
      if (dead.has(step.id)) continue;
      if (step.dependsOn.some((d) => dead.has(d))) {
        dead.add(step.id);
        changed = true;
      }
    }
  }
  const remaining = current.steps.filter((s) => !dead.has(s.id));
  const pruned = [...dead].filter((id) => id !== stepId);
  return {
    plan: plan({ scope, steps: remaining }),
    pruned,
    ...(pruned.length > 0
      ? { note: `removing ${stepId} also removed ${pruned.join(', ')}, which depended on it` }
      : {}),
  };
}

export function addStep(current: Plan, step: PlannedStep, scope: Scope): Edit {
  return { plan: plan({ scope, steps: [...current.steps, step] }), pruned: [] };
}

/** Swap the method on one step, keeping everything else. */
export function changeMethod(current: Plan, stepId: string, method: string, scope: Scope): Edit {
  const steps = current.steps.map((step) =>
    step.id === stepId ? { ...step, method } : step,
  );
  const target = current.steps.find((s) => s.id === stepId);
  const offered = target?.alternatives ?? [];
  return {
    plan: plan({ scope, steps }),
    pruned: [],
    ...(offered.length > 0 && !offered.includes(method)
      ? { note: `${method} is not one of the alternatives this step offered (${offered.join(', ')})` }
      : {}),
  };
}

/** Hand the approved plan to the coordinator. */
export function toPlanSteps(approved: Plan): Array<Omit<PlanStep, 'status'>> {
  return approved.steps.map((step) => ({
    id: step.id,
    description: step.description,
    agent: step.agent,
    dependsOn: [...step.dependsOn],
    budgetCents: step.estimatedCents,
  }));
}
