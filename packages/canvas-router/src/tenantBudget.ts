/**
 * Per-tenant monthly inference budgets (PRD 7.3).
 *
 * > Per-tenant monthly inference budgets with **soft warnings at 70 percent**
 * > and **hard stops with an override path at 100 percent**.
 *
 * Distinct from `budget.ts`, which is PRD 4.3's per-session, per-agent and
 * per-node ceilings. Those stop one canvas from running away. This one is the
 * organisation's monthly bill, and it has three parts that are easy to get
 * subtly wrong.
 *
 * ## The warning is a state, not an event
 *
 * "Soft warning at 70 percent" reads like something that fires once. Fired
 * once, it is missed once — the dispatch that crossed the line belonged to
 * whoever happened to be working at that moment, and the desk head who needed
 * to see it was in a meeting. So `check` reports the tier on *every* decision
 * and the caller surfaces it however it surfaces things. Crossing is derivable
 * from two consecutive checks; being over is not derivable from an event that
 * has already been delivered.
 *
 * ## Spend belongs to the month it happened in
 *
 * A dispatch on the 31st that is recorded on the 1st belongs to the 31st.
 * Attributing it to the month of the query instead makes a month's total
 * depend on when somebody asked, which means two reports of the same month
 * disagree — and the one that disagrees is always the one somebody is using to
 * argue about a bill.
 *
 * ## An override that does not expire is not an override
 *
 * This is the one that matters. "Hard stop with an override path" invites an
 * implementation where an override lifts the ceiling, and then nobody revisits
 * it: the hard stop fires once, somebody approves, and the tenant is
 * effectively uncapped from then on. An override here raises the ceiling by a
 * stated amount, for a stated reason, by a named person, **until a stated
 * time** — and it is scoped to one month, so it cannot silently carry into the
 * next one. A ceiling that has been raised says so.
 */

/** Cents spent, as the router reports them. */
export interface Spend {
  tenantId: string;
  /** When the dispatch happened. */
  at: number;
  cents: number;
  /** For the breakdown: which model, which task class. */
  modelId?: string;
  taskClass?: string;
}

/** PRD 7.3's two thresholds, as fractions of the ceiling. */
export const SOFT_WARNING = 0.7;
export const HARD_STOP = 1.0;

export type BudgetTier = 'ok' | 'warning' | 'stopped';

export interface Override {
  /** Which month it applies to, as `YYYY-MM` in the budget's timezone. */
  month: string;
  /** Extra cents on top of the ceiling. */
  additionalCents: number;
  /** Who approved it. A service account alone is a finding. */
  approver: string;
  /** Why. Required, for the same reason every other override here needs one. */
  reason: string;
  /** When it stops applying. An override without one is a permanent raise. */
  expiresAt: number;
}

export class InvalidOverride extends Error {
  constructor(field: string) {
    super(`an override must carry ${field}`);
    this.name = 'InvalidOverride';
  }
}

export interface BudgetDecision {
  tenantId: string;
  month: string;
  tier: BudgetTier;
  /** Cents already spent this month. */
  spentCents: number;
  /** The ceiling in force, overrides included. */
  ceilingCents: number;
  /** The ceiling before any override, so a raise is visible rather than implied. */
  baseCeilingCents: number;
  /** Spend as a fraction of the ceiling in force. */
  used: number;
  /** True when this request would be refused. */
  allowed: boolean;
  /** Cents by which the request exceeds the ceiling, when it does. */
  shortfallCents: number;
  /** Set when an override is in force, so nobody reads a raised ceiling as the ceiling. */
  override?: Override;
  /** The line the caller shows. */
  message?: string;
}

/**
 * The calendar month a timestamp falls in, in a fixed offset from UTC.
 *
 * An offset rather than a timezone name, because this file has no dependency
 * on a timezone database and a wrong answer about a month boundary is worse
 * than an explicit limitation. Callers in a zone with daylight saving supply
 * the offset in force at the time they care about.
 */
export function monthOf(at: number, utcOffsetMinutes = 0): string {
  const shifted = new Date(at + utcOffsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export interface TenantBudgetOptions {
  /** Monthly ceiling in cents. */
  ceilingCents: number;
  /** Minutes from UTC the tenant's month boundary sits at. */
  utcOffsetMinutes?: number;
}

/**
 * One tenant's monthly inference spend, its thresholds, and its overrides.
 *
 * Holds spend rather than being told a total, so the month a dispatch belongs
 * to is decided once — at the moment it is recorded, from the timestamp it
 * carries — rather than at every query.
 */
export class TenantBudget {
  private readonly byMonth = new Map<string, number>();
  private readonly overrides = new Map<string, Override>();
  private readonly offset: number;

  constructor(
    readonly tenantId: string,
    private readonly options: TenantBudgetOptions,
  ) {
    this.offset = options.utcOffsetMinutes ?? 0;
  }

  get ceilingCents(): number {
    return this.options.ceilingCents;
  }

  /** Record a dispatch against the month it happened in. */
  record(spend: Spend): void {
    const month = monthOf(spend.at, this.offset);
    this.byMonth.set(month, (this.byMonth.get(month) ?? 0) + spend.cents);
  }

  spentIn(month: string): number {
    return this.byMonth.get(month) ?? 0;
  }

  /**
   * Raise the ceiling for one month, by a named person, for a stated reason,
   * until a stated time.
   *
   * Every one of those is required. An override with no approver is a raise
   * nobody is accountable for; with no reason, a raise nobody can review; with
   * no expiry, not an override at all but a new ceiling that still calls itself
   * an exception. Scoped to one month so it cannot carry into the next.
   */
  approveOverride(override: Override): void {
    if (override.approver.trim() === '') throw new InvalidOverride('an approver');
    if (override.reason.trim() === '') throw new InvalidOverride('a reason');
    if (!Number.isFinite(override.expiresAt)) throw new InvalidOverride('an expiry');
    if (!(override.additionalCents > 0)) throw new InvalidOverride('a positive amount');
    if (!/^\d{4}-\d{2}$/.test(override.month)) throw new InvalidOverride('a month as YYYY-MM');
    this.overrides.set(override.month, { ...override });
  }

  /** The override in force for a month at a moment, if any. */
  overrideAt(month: string, now: number): Override | undefined {
    const override = this.overrides.get(month);
    if (!override) return undefined;
    return now < override.expiresAt ? override : undefined;
  }

  /**
   * Whether a request of `cents` may proceed, and which tier the tenant is in.
   *
   * The tier is reported whether or not the request is allowed, because the
   * warning is a state the caller shows rather than an event it reacts to.
   */
  check(cents: number, now: number): BudgetDecision {
    const month = monthOf(now, this.offset);
    const spent = this.spentIn(month);
    const base = this.options.ceilingCents;
    const override = this.overrideAt(month, now);
    const ceiling = base + (override?.additionalCents ?? 0);

    const projected = spent + Math.max(0, cents);
    const used = ceiling === 0 ? Infinity : spent / ceiling;
    const allowed = projected <= ceiling;
    const shortfall = allowed ? 0 : projected - ceiling;

    const tier: BudgetTier =
      spent >= ceiling * HARD_STOP ? 'stopped' : used >= SOFT_WARNING ? 'warning' : 'ok';

    const decision: BudgetDecision = {
      tenantId: this.tenantId,
      month,
      tier,
      spentCents: spent,
      ceilingCents: ceiling,
      baseCeilingCents: base,
      used,
      allowed,
      shortfallCents: shortfall,
      ...(override ? { override } : {}),
    };

    if (!allowed) {
      decision.message =
        `${this.tenantId} has spent ${money(spent)} of ${money(ceiling)} for ${month}. ` +
        `This request needs ${money(shortfall)} more than the ceiling allows.`;
    } else if (tier === 'warning') {
      decision.message =
        `${this.tenantId} has used ${(used * 100).toFixed(0)}% of its ${month} inference budget ` +
        `(${money(spent)} of ${money(ceiling)}).`;
    }
    if (override) {
      decision.message =
        `${decision.message ?? ''} Ceiling raised by ${money(override.additionalCents)} ` +
        `by ${override.approver}: ${override.reason}.`.trimStart();
    }

    return decision;
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
