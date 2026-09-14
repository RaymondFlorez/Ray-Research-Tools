/**
 * Budget enforcement (PRD 4.3).
 *
 * "Every canvas has a token and dollar budget per session, per agent, and per
 * node. The orchestrator refuses dispatch past the ceiling and surfaces a clear
 * 'this node wants $0.42 more, approve?' prompt rather than silently
 * degrading."
 *
 * *Rather than silently degrading* is the requirement. A system that quietly
 * drops to a cheaper model when money runs short produces a worse answer that
 * looks exactly like a better one, and the analyst has no way to know which
 * they are reading. Refusing and asking is louder and correct.
 */

export type Scope = 'session' | 'agent' | 'node';

export interface Ledger {
  spentCents: number;
  ceilingCents: number;
  spentTokens: number;
  ceilingTokens: number;
}

export interface BudgetRequest {
  costCents: number;
  tokens: number;
  nodeId: string;
  agentId?: string;
}

export type BudgetOutcome =
  | { allowed: true; remainingCents: number }
  | {
      allowed: false;
      /** Which ceiling stopped it — the tightest one, not the first checked. */
      scope: Scope;
      shortfallCents: number;
      /** The prompt, already phrased. */
      prompt: string;
    };

export class Budgets {
  private readonly ledgers = new Map<string, Ledger>();

  constructor(
    private readonly session: Ledger,
    private readonly perAgent: Omit<Ledger, 'spentCents' | 'spentTokens'>,
    private readonly perNode: Omit<Ledger, 'spentCents' | 'spentTokens'>,
  ) {}

  private ledgerFor(scope: Scope, id: string): Ledger {
    if (scope === 'session') return this.session;
    const key = `${scope}:${id}`;
    const existing = this.ledgers.get(key);
    if (existing) return existing;
    const limits = scope === 'agent' ? this.perAgent : this.perNode;
    const fresh: Ledger = { spentCents: 0, spentTokens: 0, ...limits };
    this.ledgers.set(key, fresh);
    return fresh;
  }

  /**
   * Whether a dispatch may proceed.
   *
   * Every scope is checked and the *tightest* refusal is reported, so the
   * prompt names the ceiling the analyst would actually have to raise. Stopping
   * at the first failure would sometimes name the session budget when the node
   * budget is the real constraint, and raising the wrong one changes nothing.
   */
  check(request: BudgetRequest): BudgetOutcome {
    const scopes: Array<[Scope, Ledger]> = [
      ['session', this.ledgerFor('session', 'session')],
      ...(request.agentId ? ([['agent', this.ledgerFor('agent', request.agentId)]] as Array<[Scope, Ledger]>) : []),
      ['node', this.ledgerFor('node', request.nodeId)],
    ];

    let worst: { scope: Scope; shortfall: number } | undefined;
    for (const [scope, ledger] of scopes) {
      const overCents = ledger.spentCents + request.costCents - ledger.ceilingCents;
      const overTokens = ledger.spentTokens + request.tokens - ledger.ceilingTokens;
      // A token ceiling that binds is reported in cents too, so the prompt has
      // one unit rather than two.
      const shortfall = Math.max(
        overCents,
        overTokens > 0 ? (overTokens / Math.max(1, request.tokens)) * request.costCents : 0,
      );
      if (shortfall > 0 && (!worst || shortfall > worst.shortfall)) {
        worst = { scope, shortfall };
      }
    }

    if (worst) {
      const dollars = (worst.shortfall / 100).toFixed(2);
      return {
        allowed: false,
        scope: worst.scope,
        shortfallCents: worst.shortfall,
        prompt: `this ${worst.scope === 'node' ? 'node' : worst.scope} wants $${dollars} more, approve?`,
      };
    }

    return {
      allowed: true,
      remainingCents: this.session.ceilingCents - this.session.spentCents - request.costCents,
    };
  }

  /** Records a dispatch that happened. */
  charge(request: BudgetRequest): void {
    for (const ledger of [
      this.ledgerFor('session', 'session'),
      ...(request.agentId ? [this.ledgerFor('agent', request.agentId)] : []),
      this.ledgerFor('node', request.nodeId),
    ]) {
      ledger.spentCents += request.costCents;
      ledger.spentTokens += request.tokens;
    }
  }

  /** Raises one ceiling, which is what approving the prompt does. */
  approve(scope: Scope, id: string, extraCents: number): void {
    this.ledgerFor(scope, id).ceilingCents += extraCents;
  }

  spent(scope: Scope, id: string): Ledger {
    return { ...this.ledgerFor(scope, id) };
  }
}
