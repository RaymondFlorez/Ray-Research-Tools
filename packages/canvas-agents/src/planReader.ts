/**
 * Reading a model's plan (PRD 5.7, `plan.decompose`).
 *
 * `plan()` takes steps from its caller; in the PRD the caller is a model that
 * decomposes the question. A model's decomposition is text, and text that
 * looks like a plan is not one: a step can name an agent the runtime does not
 * have, depend on a step that does not exist, or depend on itself by way of
 * two others. Any of those, run, is a wave that never starts.
 *
 * So `readPlan` reads and refuses. Every field is checked against the real
 * vocabularies (step kinds, agent roles, task classes), every dependency
 * against the steps, and the graph for cycles; each fault is named, and a plan
 * with any fault has no steps to run. Nothing is repaired: a dropped
 * dependency or a guessed agent is a different plan from the one proposed, and
 * the analyst would approve something the model did not say.
 *
 * Costs and durations are not read from the model. A plan that prices itself
 * can price itself under the approval threshold; `estimate` prices each step
 * from the router's own figures instead.
 */

import type { TaskClass } from '@picasso/canvas-router';
import { AGENT_ROLES } from './agentNode.js';
import type { AgentRole } from './blackboard.js';
import type { PlannedStep, StepKind } from './query.js';

export const STEP_KINDS = ['retrieval', 'compute', 'reasoning'] as const satisfies readonly StepKind[];
export const TASK_CLASSES = [
  'intent.classify', 'ink.semantic', 'sql.generate', 'quant.codegen', 'doc.extract', 'doc.deep_read', 'sentiment.subtext',
  'plan.decompose', 'synthesis.final', 'critique.redteam', 'summarize.bulk', 'embed', 'asr',
] as const satisfies readonly TaskClass[];

// Each list is the whole union: a kind, role or class added to the type and
// not here fails to compile, rather than being refused at run time.
type Exhaustive<T, L extends readonly unknown[]> = [Exclude<T, L[number]>] extends [never] ? true : never;
const _kinds: Exhaustive<StepKind, typeof STEP_KINDS> = true;
const _roles: Exhaustive<AgentRole, typeof AGENT_ROLES> = true;
const _classes: Exhaustive<TaskClass, typeof TASK_CLASSES> = true;
void _kinds;
void _roles;
void _classes;

export interface PlanReading {
  /** The steps, priced by `estimate`; empty whenever there is a problem. */
  steps: PlannedStep[];
  /** What is wrong, one line each. Empty means the plan can be shown and run. */
  problems: string[];
}

export interface ReadPlanOptions {
  /** Prices a step from the router: the model's own figures are not read. */
  estimate: (step: { kind: StepKind; taskClass?: TaskClass }) => { cents: number; ms: number };
}

const ID = /^[a-z][a-z0-9_-]{0,39}$/;

const firstJson = (text: string): unknown => {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  // The widest bracketed span from the first opener: models wrap JSON in prose and fences.
  for (let end = text.length; end > start; end -= 1) {
    const ch = text[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      // try a shorter span
    }
  }
  return undefined;
};

export function readPlan(text: string, options: ReadPlanOptions): PlanReading {
  const parsed = firstJson(text);
  const raw = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(raw)) return { steps: [], problems: ['no plan: the answer has no JSON list of steps'] };
  if (raw.length === 0) return { steps: [], problems: ['the plan has no steps'] };

  const problems: string[] = [];
  const steps: PlannedStep[] = [];
  const ids = new Set<string>();
  raw.forEach((value, index) => {
    const at = `step ${index + 1}`;
    if (typeof value !== 'object' || value === null) {
      problems.push(`${at} is not an object`);
      return;
    }
    const s = value as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id : '';
    const name = id ? `${at} (${id})` : at;
    if (!ID.test(id)) problems.push(`${name}: id must be lower case letters, digits, - or _`);
    else if (ids.has(id)) problems.push(`${name}: the id is used twice`);
    ids.add(id);
    const kind = s.kind as StepKind;
    if (!STEP_KINDS.includes(kind)) problems.push(`${name}: kind ${JSON.stringify(s.kind)} is not one of ${STEP_KINDS.join(', ')}`);
    const agent = s.agent as AgentRole;
    if (!AGENT_ROLES.includes(agent)) problems.push(`${name}: agent ${JSON.stringify(s.agent)} is not one of ${AGENT_ROLES.join(', ')}`);
    const description = typeof s.description === 'string' ? s.description.trim() : '';
    if (!description) problems.push(`${name}: no description`);
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn : s.dependsOn === undefined ? [] : null;
    if (dependsOn === null || !dependsOn.every((d) => typeof d === 'string')) problems.push(`${name}: dependsOn must be a list of step ids`);
    const taskClass = s.taskClass as TaskClass | undefined;
    if (taskClass !== undefined && !TASK_CLASSES.includes(taskClass)) {
      problems.push(`${name}: taskClass ${JSON.stringify(s.taskClass)} is not one the router knows`);
    }
    // A reasoning step is a model call; the router needs its class to choose the model.
    if (kind === 'reasoning' && taskClass === undefined) problems.push(`${name}: a reasoning step names the taskClass it dispatches`);
    const method = typeof s.method === 'string' && s.method.trim() ? s.method.trim() : undefined;
    const priced = STEP_KINDS.includes(kind) ? options.estimate({ kind, ...(taskClass !== undefined ? { taskClass } : {}) }) : { cents: 0, ms: 0 };
    steps.push({
      id,
      kind,
      description,
      agent,
      ...(taskClass !== undefined ? { taskClass } : {}),
      dependsOn: (dependsOn ?? []) as string[],
      estimatedCents: priced.cents,
      estimatedMs: priced.ms,
      ...(method !== undefined ? { method } : {}),
    });
  });

  for (const step of steps) {
    for (const d of step.dependsOn) {
      if (d === step.id) problems.push(`${step.id} depends on itself`);
      else if (!ids.has(d)) problems.push(`${step.id} depends on ${JSON.stringify(d)}, which is not a step`);
    }
  }
  const cycle = findCycle(steps);
  if (cycle) problems.push(`the steps ${cycle.join(' -> ')} depend on each other in a circle, so none of them can start`);

  return problems.length > 0 ? { steps: [], problems } : { steps, problems };
}

function findCycle(steps: readonly PlannedStep[]): string[] | undefined {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    const step = byId.get(id);
    if (!step) return undefined;
    state.set(id, 'open');
    path.push(id);
    for (const d of step.dependsOn) {
      if (d === id) continue;
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return undefined;
}
