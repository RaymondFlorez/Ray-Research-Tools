/**
 * The blackboard runtime (PRD 4.5).
 *
 * "The Coordinator owns turn allocation and the budget."
 *
 * Turn allocation here is wave scheduling over the plan's dependency graph:
 * every step whose dependencies are done runs in the same wave. That is what
 * makes the worked example's shape real rather than narrated — "t=0.5s Branch
 * A... t=0.5s Branch B in parallel... t=22s Join" is a dependency graph with
 * two roots and a sink, and a runtime that walks a list in order produces the
 * same answer 40 seconds later.
 *
 * The budget is the Coordinator's because the alternative is each agent
 * checking its own ceiling, which means the last agent to run is the one that
 * gets refused regardless of whether it was the expensive one. Steps are
 * charged against a shared board budget at their allocated cost, and a refused
 * step does not silently shrink: PRD 4.4's rule is that the system asks. So
 * the step is skipped, the question goes on the board, and everything
 * downstream of it is skipped too rather than running on missing inputs.
 */

import type { Blackboard, PlanStep, AgentRole } from './blackboard.js';
import {
  patch,
  reconcile,
  type CellReading,
  type Correction,
  type Finding,
  type Narrative,
} from './reconciler.js';

export interface AgentContext {
  board: Blackboard;
  step: PlanStep;
  /** What the Coordinator allocated. Spending more is allowed; it is charged. */
  budgetCents: number;
}

export interface AgentOutcome {
  costCents?: number;
  tokens?: number;
  note?: string;
  /** Node ids the step materialized on the canvas. */
  artifacts?: Array<{ nodeId: string; kind: string }>;
}

export type AgentFn = (ctx: AgentContext) => Promise<AgentOutcome> | AgentOutcome;

export interface JoinSpec {
  /** The Scribe's draft, as it currently stands. */
  narrative: () => Narrative;
  /** Live cell readings for every node the narrative may cite. */
  cells: () => readonly CellReading[];
  /**
   * Re-run the Scribe with the numbers as structured input.
   *
   * Absent, the join applies the corrections mechanically instead. See
   * `patch` in `reconciler.ts` for why that fallback exists.
   */
  rerunScribe?: (corrections: readonly Correction[], previous: Narrative) => Promise<Narrative> | Narrative;
  documents?: ReadonlyMap<string, string>;
  /** How many Scribe attempts before the join gives up and says so. */
  maxAttempts?: number;
  /** Charged per Scribe rerun. */
  rerunCostCents?: number;
}

export interface JoinResult {
  ok: boolean;
  attempts: number;
  narrative: Narrative;
  findings: Finding[];
  /** Every round's findings, so a repeated failure is visible as a pattern. */
  rounds: Finding[][];
}

export interface RunResult {
  completed: string[];
  failed: string[];
  skipped: string[];
  join?: JoinResult;
  waves: number;
}

export interface RunInput {
  board: Blackboard;
  agents: Record<string, AgentFn>;
  join?: JoinSpec;
  /** A runaway plan stops here rather than looping. */
  maxWaves?: number;
}

export async function run(input: RunInput): Promise<RunResult> {
  const { board } = input;
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const maxWaves = input.maxWaves ?? 32;
  let waves = 0;

  for (;;) {
    const ready = board.ready();
    if (ready.length === 0) break;
    if (waves >= maxWaves) {
      board.say({ from: 'coordinator', kind: 'error', text: `plan did not settle in ${maxWaves} waves` });
      break;
    }
    waves += 1;

    // Every step in a wave is independent by construction, so they run
    // together. Results are collected in the wave's order, which keeps a run
    // reproducible even though the steps overlap.
    const outcomes = await Promise.all(
      ready.map(async (step): Promise<[PlanStep, AgentOutcome | Error | 'refused']> => {
        const agent = input.agents[step.id];
        if (!agent) return [step, new Error(`no agent registered for step ${step.id}`)];
        if (!board.charge(step.budgetCents, 0)) return [step, 'refused'];
        board.updateStep(step.id, { status: 'running', startedAt: Date.now() });
        try {
          return [step, await agent({ board, step, budgetCents: step.budgetCents })];
        } catch (error) {
          return [step, error instanceof Error ? error : new Error(String(error))];
        }
      }),
    );

    for (const [step, outcome] of outcomes) {
      if (outcome === 'refused') {
        board.updateStep(step.id, { status: 'skipped', note: 'budget ceiling' });
        skipped.push(step.id);
        board.ask(
          `"${step.description}" needs about ${step.budgetCents} cents and the ceiling is reached. Raise it?`,
        );
        board.say({
          from: 'coordinator',
          kind: 'note',
          text: `skipped ${step.id}: budget ceiling reached, asking rather than degrading`,
        });
        continue;
      }
      if (outcome instanceof Error) {
        board.updateStep(step.id, { status: 'failed', note: outcome.message, finishedAt: Date.now() });
        failed.push(step.id);
        board.say({ from: step.agent, kind: 'error', text: `${step.id}: ${outcome.message}` });
        continue;
      }
      // An agent that spent more than its allocation is charged the difference.
      const extra = (outcome.costCents ?? step.budgetCents) - step.budgetCents;
      if (extra > 0) board.charge(extra, outcome.tokens ?? 0);
      else board.charge(0, outcome.tokens ?? 0);
      for (const artifact of outcome.artifacts ?? []) {
        board.addArtifact({ ...artifact, createdBy: step.agent });
      }
      board.updateStep(step.id, {
        status: 'done',
        finishedAt: Date.now(),
        spentCents: outcome.costCents ?? step.budgetCents,
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
      completed.push(step.id);
    }

    // A step whose dependency failed or was skipped can never become ready, so
    // mark it now. Leaving it `pending` would end the run with a plan that
    // looks half-finished for no stated reason.
    cascadeSkips(board, skipped);
  }

  const result: RunResult = { completed, failed, skipped, waves };
  if (input.join) {
    result.join = await joinAndReconcile(board, input.join);
  }
  return result;
}

function cascadeSkips(board: Blackboard, skipped: string[]): void {
  const dead = new Set(
    board.steps().filter((s) => s.status === 'failed' || s.status === 'skipped').map((s) => s.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of board.steps()) {
      if (step.status !== 'pending') continue;
      const blocker = step.dependsOn.find((d) => dead.has(d));
      if (blocker === undefined) continue;
      board.updateStep(step.id, { status: 'skipped', note: `depends on ${blocker}` });
      dead.add(step.id);
      skipped.push(step.id);
      changed = true;
    }
  }
}

/**
 * The join (PRD 4.5, t=22s).
 *
 * "Reconciler checks that the delta and vega totals in the narrative match the
 * simulation node's actual outputs. Any mismatch fails the join and reruns the
 * Scribe with corrected numbers."
 *
 * Reruns are bounded and every round's findings are kept. A Scribe that fails
 * the same way three times is not having bad luck — it is reading a number
 * from somewhere the corrections do not reach — and a runtime that retries
 * silently until it runs out of attempts hides exactly that.
 */
export async function joinAndReconcile(board: Blackboard, spec: JoinSpec): Promise<JoinResult> {
  const maxAttempts = spec.maxAttempts ?? 3;
  const rounds: Finding[][] = [];
  let narrative = spec.narrative();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = reconcile({
      narrative,
      facts: board,
      cells: spec.cells(),
      ...(spec.documents ? { documents: spec.documents } : {}),
    });
    rounds.push(result.findings);
    if (result.ok) {
      board.say({
        from: 'reconciler',
        kind: 'resolve',
        text:
          attempt === 1
            ? `join passed: ${result.checked} cited number${result.checked === 1 ? '' : 's'} trace to cells`
            : `join passed on attempt ${attempt}`,
      });
      return { ok: true, attempts: attempt, narrative, findings: [], rounds };
    }

    board.say({
      from: 'reconciler',
      kind: 'conflict',
      text: `join failed: ${result.findings.map((f) => `${f.kind} (${f.message})`).join('; ')}`,
    });

    if (attempt === maxAttempts || result.corrections.length === 0) {
      return { ok: false, attempts: attempt, narrative, findings: result.findings, rounds };
    }

    if (!board.charge(spec.rerunCostCents ?? 0, 0)) {
      board.ask('The Scribe needs another pass to fix its numbers, and the budget is spent. Raise it?');
      return { ok: false, attempts: attempt, narrative, findings: result.findings, rounds };
    }

    narrative = spec.rerunScribe
      ? await spec.rerunScribe(result.corrections, narrative)
      : patch(narrative, result.corrections);
    board.say({
      from: 'scribe' as AgentRole,
      kind: 'draft',
      text: `redrafted with ${result.corrections.length} corrected number${result.corrections.length === 1 ? '' : 's'}`,
    });
  }

  /* c8 ignore next */
  return { ok: false, attempts: maxAttempts, narrative, findings: rounds.at(-1) ?? [], rounds };
}
