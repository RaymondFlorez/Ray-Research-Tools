/**
 * The blackboard (PRD 4.5).
 *
 * "Complex nodes run a blackboard architecture rather than a fixed pipeline.
 * Agents read and write a shared, typed workspace scoped to a subgraph. The
 * Coordinator owns turn allocation and the budget."
 *
 * The schema is Appendix-A-shaped and the one structural rule the PRD states
 * about it is that `facts` are append-only. That rule is what makes the
 * transcript an audit trail instead of a log: if a later agent could overwrite
 * an earlier agent's number, the record of the disagreement — which is the
 * thing the Reconciler exists to resolve — would be gone by the time anyone
 * looked.
 *
 * So nothing here mutates a stored fact. `contested` is in the PRD's `Fact`
 * shape, but it is a property of the *set* (does another live fact claim
 * something different about the same thing?), not of the assertion, so it is
 * computed on read. An asserting agent cannot mark its own claim uncontested,
 * and resolving a conflict clears the flag without rewriting history.
 */

import { sameUnit, toleranceFor, findNumerals } from './numeric.js';

export type AgentRole =
  | 'coordinator'
  | 'retriever'
  | 'extractor'
  | 'quant'
  | 'simulator'
  | 'critic'
  | 'reconciler'
  | 'scribe';

export type Provenance =
  /**
   * A value read off a node's output port.
   *
   * `port` is what distinguishes two numbers from one node, and leaving it out
   * was a real bug rather than a simplification: the PRD's own worked example
   * has an aggregation node emitting delta *and* vega, and a reconciler that
   * identifies a reading by `nodeId` alone can only ever check one of them.
   * The other silently matched its neighbour's reading and came back as a
   * stale-cache finding on a number that was correct. Optional, because a
   * single-output node has nothing to disambiguate.
   */
  | { kind: 'cell'; nodeId: string; cacheKey: string; port?: string }
  | { kind: 'document'; docId: string; page: number; charStart: number; charEnd: number }
  /** Marked UNVERIFIED. See `provenance.ts` for what that forbids. */
  | { kind: 'model'; traceId: string };

export interface Quantity {
  number: number;
  unit: string;
  asof: string;
}

/**
 * How a fact was computed from other facts.
 *
 * Not in the PRD's schema, and it earns its place: the Reconciler's worked
 * example is a *total* that disagrees with the node that produced the parts.
 * A total that only carries its own provenance can be checked against the cell
 * it came from but not against the numbers it is supposed to be the sum of, so
 * an agent that adds four legs wrong and cites the aggregation node passes
 * every other check in this file.
 */
export interface Derivation {
  op: 'sum' | 'difference' | 'product' | 'ratio';
  operands: string[];
}

export interface Fact {
  id: string;
  claim: string;
  value?: Quantity;
  provenance: Provenance;
  confidence: number;
  contested: boolean;
  assertedBy: AgentRole;
  derivation?: Derivation;
  /** When it hit the board, for the transcript's ordering. */
  at: number;
  /** Set when a conflict naming this fact was resolved against it. */
  retracted?: boolean;
}

export interface Conflict {
  id: string;
  /** The claim two agents disagree about. */
  claim: string;
  factIds: string[];
  /** Set once the Reconciler picks a winner. */
  resolvedFactId?: string;
  reason?: string;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  description: string;
  agent: AgentRole;
  /** Step ids that must reach `done` first. Empty means it can start now. */
  dependsOn: string[];
  status: StepStatus;
  /** What the Coordinator allocated to this step. */
  budgetCents: number;
  spentCents?: number;
  startedAt?: number;
  finishedAt?: number;
  note?: string;
}

export interface ArtifactRef {
  nodeId: string;
  kind: string;
  createdBy: AgentRole;
}

export interface AgentMessage {
  at: number;
  from: AgentRole;
  kind: 'plan' | 'assert' | 'conflict' | 'resolve' | 'draft' | 'critique' | 'error' | 'note';
  text: string;
  factIds?: string[];
  costCents?: number;
}

export interface BudgetState {
  spentCents: number;
  ceilingCents: number;
  tokensUsed: number;
}

export interface BlackboardSnapshot {
  taskId: string;
  question: string;
  plan: PlanStep[];
  facts: Fact[];
  artifacts: ArtifactRef[];
  conflicts: Conflict[];
  openQuestions: string[];
  budget: BudgetState;
  transcript: AgentMessage[];
}

export class AppendOnlyViolation extends Error {
  constructor(id: string) {
    super(`fact ${id} already on the board; facts are append-only`);
    this.name = 'AppendOnlyViolation';
  }
}

export class Blackboard {
  private readonly stored: Fact[] = [];
  private readonly conflictList: Conflict[] = [];
  private readonly messages: AgentMessage[] = [];
  private readonly artifactList: ArtifactRef[] = [];
  private readonly questions: string[] = [];
  private plan: PlanStep[] = [];
  private clock = 0;
  private readonly budget: BudgetState;

  constructor(
    readonly taskId: string,
    readonly question: string,
    ceilingCents: number,
  ) {
    this.budget = { spentCents: 0, ceilingCents, tokensUsed: 0 };
  }

  /** Monotone logical time, so a test does not depend on wall-clock ordering. */
  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  setPlan(steps: readonly Omit<PlanStep, 'status'>[], by: AgentRole = 'coordinator'): void {
    this.plan = steps.map((s) => ({ ...s, status: 'pending' as StepStatus }));
    this.say({
      from: by,
      kind: 'plan',
      text: `plan of ${steps.length} step${steps.length === 1 ? '' : 's'}`,
    });
  }

  steps(): readonly PlanStep[] {
    return this.plan;
  }

  step(id: string): PlanStep | undefined {
    return this.plan.find((s) => s.id === id);
  }

  updateStep(id: string, patch: Partial<PlanStep>): void {
    const step = this.plan.find((s) => s.id === id);
    if (!step) throw new Error(`no plan step ${id}`);
    Object.assign(step, patch);
  }

  /** Steps whose dependencies are all `done` and which have not started. */
  ready(): PlanStep[] {
    const done = new Set(this.plan.filter((s) => s.status === 'done').map((s) => s.id));
    return this.plan.filter(
      (s) => s.status === 'pending' && s.dependsOn.every((d) => done.has(d)),
    );
  }

  /**
   * Put a fact on the board.
   *
   * Appends, then re-derives the conflict set for the claim. A conflicting
   * pair is recorded once and both sides read as contested until somebody
   * resolves it; neither side is deleted, because the Reconciler needs to see
   * what it is choosing between.
   */
  assert(fact: Omit<Fact, 'contested' | 'at'>): Fact {
    if (this.stored.some((f) => f.id === fact.id)) throw new AppendOnlyViolation(fact.id);
    const stored: Fact = { ...fact, contested: false, at: this.tick() };
    this.stored.push(stored);
    this.say({
      from: fact.assertedBy,
      kind: 'assert',
      text: fact.claim,
      factIds: [fact.id],
    });
    this.detectConflicts(stored);
    return this.read(stored);
  }

  private detectConflicts(fresh: Fact): void {
    if (!fresh.value) return;
    for (const other of this.stored) {
      if (other.id === fresh.id || other.retracted) continue;
      if (other.claim !== fresh.claim || !other.value) continue;
      if (this.valuesAgree(other.value, fresh.value)) continue;
      const existing = this.conflictList.find(
        (c) => c.claim === fresh.claim && c.resolvedFactId === undefined,
      );
      if (existing) {
        if (!existing.factIds.includes(fresh.id)) existing.factIds.push(fresh.id);
        if (!existing.factIds.includes(other.id)) existing.factIds.push(other.id);
      } else {
        this.conflictList.push({
          id: `conflict-${this.conflictList.length + 1}`,
          claim: fresh.claim,
          factIds: [other.id, fresh.id],
        });
      }
      this.say({
        from: 'reconciler',
        kind: 'conflict',
        text: `${fresh.assertedBy} and ${other.assertedBy} disagree on "${fresh.claim}"`,
        factIds: [other.id, fresh.id],
      });
    }
  }

  /**
   * Whether two asserted quantities are the same claim.
   *
   * Units must match — a `pct` and a `bps` reading of the same claim disagree
   * whatever the digits say — and the numbers must fall inside the tighter of
   * the two renderings. Taking the looser band would let a vague assertion
   * swallow a precise one.
   */
  private valuesAgree(a: Quantity, b: Quantity): boolean {
    if (!sameUnit(a.unit, b.unit)) return false;
    const band = Math.min(bandOf(a.number), bandOf(b.number));
    return Math.abs(a.number - b.number) <= band;
  }

  /** The facts as they currently read, with `contested` derived. */
  facts(): Fact[] {
    return this.stored.map((f) => this.read(f));
  }

  fact(id: string): Fact | undefined {
    const found = this.stored.find((f) => f.id === id);
    return found ? this.read(found) : undefined;
  }

  private read(fact: Fact): Fact {
    const contested = this.conflictList.some(
      (c) => c.resolvedFactId === undefined && c.factIds.includes(fact.id),
    );
    return { ...fact, contested };
  }

  conflicts(): readonly Conflict[] {
    return this.conflictList;
  }

  /**
   * Settle a conflict in favour of one of its facts.
   *
   * The losing facts are marked retracted rather than removed: the transcript
   * still shows who said what, and a later agent reading the board cannot pick
   * the retracted number back up.
   */
  resolveConflict(conflictId: string, winningFactId: string, reason: string): void {
    const conflict = this.conflictList.find((c) => c.id === conflictId);
    if (!conflict) throw new Error(`no conflict ${conflictId}`);
    if (!conflict.factIds.includes(winningFactId)) {
      throw new Error(`fact ${winningFactId} is not part of ${conflictId}`);
    }
    conflict.resolvedFactId = winningFactId;
    conflict.reason = reason;
    for (const id of conflict.factIds) {
      if (id === winningFactId) continue;
      const loser = this.stored.find((f) => f.id === id);
      if (loser) loser.retracted = true;
    }
    this.say({
      from: 'reconciler',
      kind: 'resolve',
      text: `${conflict.claim}: kept ${winningFactId} — ${reason}`,
      factIds: conflict.factIds,
    });
  }

  addArtifact(ref: ArtifactRef): void {
    this.artifactList.push(ref);
  }

  artifacts(): readonly ArtifactRef[] {
    return this.artifactList;
  }

  ask(question: string): void {
    if (!this.questions.includes(question)) this.questions.push(question);
  }

  openQuestions(): readonly string[] {
    return this.questions;
  }

  say(message: Omit<AgentMessage, 'at'>): void {
    this.messages.push({ ...message, at: this.tick() });
  }

  transcript(): readonly AgentMessage[] {
    return this.messages;
  }

  /**
   * Charge the shared budget.
   *
   * Returns false without spending when the charge would breach the ceiling.
   * The Coordinator decides what to do about that — PRD 4.4's rule is that the
   * system asks rather than silently degrading — so this does not throw and
   * does not substitute a cheaper plan on its own.
   */
  charge(cents: number, tokens: number): boolean {
    if (this.budget.spentCents + cents > this.budget.ceilingCents) return false;
    this.budget.spentCents += cents;
    this.budget.tokensUsed += tokens;
    return true;
  }

  budgetState(): BudgetState {
    return { ...this.budget };
  }

  snapshot(): BlackboardSnapshot {
    return {
      taskId: this.taskId,
      question: this.question,
      plan: this.plan.map((s) => ({ ...s })),
      facts: this.facts(),
      artifacts: [...this.artifactList],
      conflicts: this.conflictList.map((c) => ({ ...c, factIds: [...c.factIds] })),
      openQuestions: [...this.questions],
      budget: this.budgetState(),
      transcript: [...this.messages],
    };
  }
}

/**
 * The band an asserted number claims, read off how it would print.
 *
 * A `Quantity` carries a float, not a rendering, so there is no literal to
 * measure. Reconstructing one from the value's own precision keeps the rule
 * the same as the narrative's: an agent asserting -3870 is claiming the ones
 * digit, one asserting -3870.4 is claiming the tenths.
 */
function bandOf(value: number): number {
  const printed = String(value);
  // Exponent notation has no last displayed place to read; a relative band
  // keeps two genuinely different tiny numbers from agreeing by accident.
  if (/e/i.test(printed)) return Math.abs(value) * 1e-9;
  const numerals = findNumerals(printed);
  const first = numerals[0];
  if (!first) return 0;
  return toleranceFor(first);
}
