/**
 * The tracker that remembers (PRD 3.5).
 *
 * "Picasso then tracks the claim automatically: as data arrives, the
 * hypothesis node updates a status ... and logs the analyst's calibration
 * history over time."
 *
 * `resolve` answers what a claim's status is, given its data and the clock.
 * This answers the other half: where the claims and the data live, what
 * re-checks them when a number arrives, and what the calibration history is
 * read from.
 *
 * **The ledger is an append-only log of three events** — a claim stated, a
 * number observed, a claim withdrawn — and every status is derived from it,
 * never stored. There is no edit, no delete and no way to reach the log's
 * array: `events()` hands out copies, as `AuditLog` does in `canvas-guard`.
 * A track record that could be edited would be a scoreboard.
 *
 * The rules that make the record honest are enforced here rather than
 * documented:
 *
 *  - **The ledger dates a claim, not the caller.** A claim's `createdAt` is the
 *    moment the ledger received it. A caller-supplied date earlier than that
 *    would let a claim be written after the answer was known.
 *  - **The first number received counts.** Once an observable has a counting
 *    observation for a claim, later ones — a restatement, a backfill dated
 *    earlier — are logged and change nothing. `resolve` already takes the
 *    earliest *dated* observation; the ledger takes the earliest *received*, so
 *    a number backdated into the log cannot displace the one that settled the
 *    call.
 *  - **The clock does not run backwards.** Every event is at or after the last.
 *  - **A claim can be withdrawn only before any of its data has arrived**, the
 *    withdrawal needs a reason, and it stays on the record and in the tally.
 *  - **A claim id is used once.** Changing a claim is stating a new one.
 *
 * Persistence is the log: it is plain JSON, and `replay` rebuilds a ledger by
 * applying each event through the same methods a live caller uses, so a log
 * that a live ledger would have refused is refused on replay too.
 */

import type { Scored } from './calibration.js';
import { trackRecord } from './calibration.js';
import {
  resolve,
  validate,
  type Hypothesis,
  type HypothesisStatus,
  type Observation,
  type Resolution,
} from './hypothesis.js';

export type LedgerEvent =
  | { seq: number; at: string; kind: 'stated'; hypothesis: Hypothesis }
  | { seq: number; at: string; kind: 'observed'; observation: Observation }
  | { seq: number; at: string; kind: 'withdrawn'; hypothesisId: string; reason: string };

/** An event before the ledger numbers it; `Omit` over the union, member by member. */
type Unsequenced = LedgerEvent extends infer E ? (E extends LedgerEvent ? Omit<E, 'seq'> : never) : never;

export class LedgerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerRefused';
  }
}

/** A status change the ledger noticed: what a trigger would notify on. */
export interface Transition {
  hypothesisId: string;
  from: HypothesisStatus;
  to: HypothesisStatus;
  resolution: Resolution;
}

export interface Counted {
  observation: Observation;
  /** When the ledger received it, which may be later than it is dated. */
  recordedAt: string;
}

export interface Entry {
  hypothesis: Hypothesis;
  resolution: Resolution;
  /** The observations that count toward the claim, one per observable at most. */
  counted: Counted[];
  withdrawn?: { at: string; reason: string };
}

export interface Filter {
  author?: string;
  /** "Prior calls of the same shape" (PRD 7.4) — the shape is the caller's to define. */
  matching?: (hypothesis: Hypothesis) => boolean;
}

export interface Tally {
  stated: number;
  /** Still awaiting data. */
  open: number;
  supported: number;
  contradicted: number;
  /** Every observable reported, and the data said nothing either way. */
  inconclusive: number;
  expired: number;
  withdrawn: number;
}

interface Claim {
  hypothesis: Hypothesis;
  counted: Map<string, Counted>;
  withdrawn?: { at: string; reason: string };
}

const copy = <T>(value: T): T => structuredClone(value);

export class HypothesisLedger {
  private readonly log: LedgerEvent[] = [];
  private readonly claims = new Map<string, Claim>();
  /** Which claims name each observable, so a number reaches every claim wired to it. */
  private readonly watchers = new Map<string, string[]>();
  /** The status last reported for each claim; what a transition is measured from. */
  private readonly reported = new Map<string, HypothesisStatus>();
  private clock = '';

  /** Rebuilds a ledger from its log, refusing anything a live ledger would. */
  static replay(events: readonly LedgerEvent[]): HypothesisLedger {
    const ledger = new HypothesisLedger();
    events.forEach((event, i) => {
      if (event.seq !== i + 1) {
        throw new LedgerRefused(`event ${i + 1} carries seq ${event.seq}: the log has a gap or is out of order`);
      }
      switch (event.kind) {
        case 'stated':
          ledger.state(event.hypothesis, event.at);
          break;
        case 'observed':
          ledger.observe(event.observation, event.at);
          break;
        case 'withdrawn':
          ledger.withdraw(event.hypothesisId, event.reason, event.at);
          break;
        default:
          throw new LedgerRefused(`event ${i + 1} is of no kind the ledger records`);
      }
    });
    return ledger;
  }

  /** Records a claim, dated now. Returns it as stored. */
  state(hypothesis: Hypothesis, at: string): Hypothesis {
    this.checkClock(at);
    if (this.claims.has(hypothesis.id)) {
      throw new LedgerRefused(`${hypothesis.id} is already on the record; a changed claim is a new claim with a new id`);
    }
    const stored = copy({ ...hypothesis, createdAt: at });
    const problems = validate(stored);
    if (problems.length > 0) throw new LedgerRefused(`${hypothesis.id}: ${problems[0]}`);
    this.append({ at, kind: 'stated', hypothesis: stored });
    this.claims.set(stored.id, { hypothesis: stored, counted: new Map() });
    for (const observable of stored.observables) {
      const list = this.watchers.get(observable.id) ?? [];
      list.push(stored.id);
      this.watchers.set(observable.id, list);
    }
    this.reported.set(stored.id, this.resolution(this.claims.get(stored.id)!, at).status);
    return copy(stored);
  }

  /**
   * Records a number and re-resolves every claim, returning what changed.
   *
   * This is the trigger: the claim settles when its data arrives, "whether or
   * not she remembers it". Expiries that came due since the last event are
   * reported here too, since the sweep covers every open claim.
   */
  observe(observation: Observation, at: string): Transition[] {
    if (!(observation.observedAt <= at)) {
      throw new LedgerRefused(
        `an observation dated ${observation.observedAt} cannot have been received at ${at}`,
      );
    }
    if (!Number.isFinite(observation.value)) {
      throw new LedgerRefused(`${observation.observableId}: an observation must be a finite number`);
    }
    this.checkClock(at);
    const stored = copy(observation);
    this.append({ at, kind: 'observed', observation: stored });
    for (const id of this.watchers.get(observation.observableId) ?? []) {
      const claim = this.claims.get(id)!;
      if (claim.withdrawn || claim.counted.has(observation.observableId)) continue;
      const observable = claim.hypothesis.observables.find((o) => o.id === observation.observableId)!;
      // The same window `resolve` applies; a number outside it is logged and
      // does not take the observable's one slot.
      if (observation.observedAt > claim.hypothesis.createdAt && observation.observedAt <= observable.dueBy) {
        claim.counted.set(observation.observableId, { observation: copy(stored), recordedAt: at });
      }
    }
    return this.sweep(at);
  }

  /** Withdraws a claim that no data has yet touched. */
  withdraw(hypothesisId: string, reason: string, at: string): void {
    this.checkClock(at);
    const claim = this.claims.get(hypothesisId);
    if (!claim) throw new LedgerRefused(`${hypothesisId} is not on the record`);
    if (claim.withdrawn) throw new LedgerRefused(`${hypothesisId} was already withdrawn at ${claim.withdrawn.at}`);
    if (reason.trim() === '') throw new LedgerRefused('a withdrawal must carry a reason');
    if (claim.counted.size > 0) {
      throw new LedgerRefused(`${hypothesisId} has data against it; a claim cannot be withdrawn once it is being scored`);
    }
    if (this.resolution(claim, at).status !== 'undetermined') {
      throw new LedgerRefused(`${hypothesisId} has expired; an expired claim stays on the record as one`);
    }
    this.append({ at, kind: 'withdrawn', hypothesisId, reason });
    claim.withdrawn = { at, reason };
    this.reported.delete(hypothesisId);
  }

  /**
   * Re-resolves every open claim against the clock, returning what changed.
   *
   * Nothing is logged: expiry is a function of the claims and the time, so
   * there is nothing to remember. The clock still advances, so a later event
   * cannot be dated before a tick that has already reported an expiry.
   */
  tick(now: string): Transition[] {
    this.checkClock(now);
    this.clock = now;
    return this.sweep(now);
  }

  entry(hypothesisId: string, now: string): Entry | undefined {
    const claim = this.claims.get(hypothesisId);
    return claim ? this.toEntry(claim, now) : undefined;
  }

  entries(now: string, filter: Filter = {}): Entry[] {
    return [...this.claims.values()].filter((c) => matches(c.hypothesis, filter)).map((c) => this.toEntry(c, now));
  }

  /**
   * The resolved calls, as calibration and the Critic's base rate read them.
   *
   * Only supported and contradicted claims carry an outcome. Neither depends
   * on the clock — a claim settles on its data — so this takes none.
   */
  scored(filter: Filter = {}): Scored[] {
    const out: Scored[] = [];
    for (const claim of this.claims.values()) {
      if (claim.withdrawn || !matches(claim.hypothesis, filter)) continue;
      const resolution = this.resolution(claim, this.clock);
      if (resolution.outcome === undefined) continue;
      out.push({
        confidence: claim.hypothesis.confidence,
        outcome: resolution.outcome,
        id: claim.hypothesis.id,
        ...(resolution.resolvedAt !== undefined ? { resolvedAt: resolution.resolvedAt } : {}),
      });
    }
    return out.sort((a, b) => (a.resolvedAt ?? '').localeCompare(b.resolvedAt ?? '') || a.id!.localeCompare(b.id!));
  }

  tally(now: string, filter: Filter = {}): Tally {
    const tally: Tally = { stated: 0, open: 0, supported: 0, contradicted: 0, inconclusive: 0, expired: 0, withdrawn: 0 };
    for (const entry of this.entries(now, filter)) {
      tally.stated += 1;
      if (entry.withdrawn) {
        tally.withdrawn += 1;
        continue;
      }
      const { status, outcomes } = entry.resolution;
      if (status === 'supported') tally.supported += 1;
      else if (status === 'contradicted') tally.contradicted += 1;
      else if (status === 'expired') tally.expired += 1;
      else if (outcomes.some((o) => o.value === undefined)) tally.open += 1;
      else tally.inconclusive += 1;
    }
    return tally;
  }

  /**
   * The Critic's sentence, with what the score leaves out said after it.
   *
   * "Made this call three times, right once" counts resolved calls only. An
   * analyst who withdrew two more before the data came, or let them expire, has
   * a record the sentence alone flatters, so those are named when there are any.
   */
  record(subject: string, now: string, filter: Filter = {}): string {
    const sentence = trackRecord(this.scored(filter), subject);
    const tally = this.tally(now, filter);
    const unscored = [
      tally.inconclusive > 0 ? `${tally.inconclusive} inconclusive` : '',
      tally.expired > 0 ? `${tally.expired} expired unchecked` : '',
      tally.withdrawn > 0 ? `${tally.withdrawn} withdrawn before the data` : '',
    ].filter((s) => s !== '');
    return unscored.length > 0 ? `${sentence} (${unscored.join(', ')})` : sentence;
  }

  /** The log, as copies. The only way to persist a ledger, and to audit one. */
  events(): LedgerEvent[] {
    return this.log.map(copy);
  }

  private checkClock(at: string): void {
    if (at < this.clock) {
      throw new LedgerRefused(`${at} is before ${this.clock}; the ledger's clock does not run backwards`);
    }
  }

  /** Called only once every check on the event has passed. */
  private append(event: Unsequenced): void {
    this.clock = event.at;
    this.log.push({ ...event, seq: this.log.length + 1 });
  }

  private resolution(claim: Claim, now: string): Resolution {
    return resolve(claim.hypothesis, [...claim.counted.values()].map((c) => c.observation), now);
  }

  private sweep(now: string): Transition[] {
    const changed: Transition[] = [];
    for (const claim of this.claims.values()) {
      if (claim.withdrawn) continue;
      const id = claim.hypothesis.id;
      const resolution = this.resolution(claim, now);
      const from = this.reported.get(id)!;
      if (resolution.status !== from) {
        changed.push({ hypothesisId: id, from, to: resolution.status, resolution: copy(resolution) });
        this.reported.set(id, resolution.status);
      }
    }
    return changed;
  }

  private toEntry(claim: Claim, now: string): Entry {
    const at = claim.withdrawn ? claim.withdrawn.at : now;
    return copy({
      hypothesis: claim.hypothesis,
      resolution: this.resolution(claim, at),
      counted: [...claim.counted.values()],
      ...(claim.withdrawn ? { withdrawn: claim.withdrawn } : {}),
    });
  }
}

function matches(hypothesis: Hypothesis, filter: Filter): boolean {
  if (filter.author !== undefined && hypothesis.author !== filter.author) return false;
  // A copy, so a predicate cannot edit the claim it is shown.
  return filter.matching ? filter.matching(copy(hypothesis)) : true;
}
