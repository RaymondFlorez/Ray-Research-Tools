/**
 * Point-in-time reads (PRD 5.8, 3.8, 5.2).
 *
 * "Point-in-time data enforced at the `data-access` layer: a backtest at date T
 * cannot see any record whose knowledge-time exceeds T. This is enforced by
 * Iceberg snapshot pinning, not by convention."
 *
 * Two clocks, and confusing them is the single most common way a research
 * platform lies to its users:
 *
 *   **valid time** — the date the fact is *about*. Q3 revenue is about Q3.
 *   **knowledge time** — the moment we *learned* it. Q3 revenue was first
 *   reported in October, restated the following February, and restated again a
 *   year later.
 *
 * A chart of "Q3 revenue" drawn today shows the latest restatement. A backtest
 * standing in October must see the number that was on the tape in October, or
 * it is trading on information that did not exist. The same applies to the
 * canvas time scrub: setting asof to a morning last August has to reproduce
 * that morning, restatements and all.
 *
 * Records are never edited or deleted. A correction is a new record with a
 * later knowledge time, which is what makes a historical read reproducible
 * forever — and why the store is append-only in the same way ink is.
 */

/** ISO-8601 instant. Strings rather than Date, so records serialize verbatim. */
export type Instant = string;

export interface Fact<T> {
  /** What the fact is about: the series key, the field, the entity. */
  key: string;
  /** The date the fact describes. */
  validTime: Instant;
  /** When this version of the fact became known. */
  knowledgeTime: Instant;
  value: T;
  /** Where it came from, carried through to provenance. */
  source?: string;
  /**
   * Set when this record supersedes an earlier one for the same key and valid
   * time. Restatements are visible, not silent.
   */
  restatement?: boolean;
}

export interface AsOfQuery {
  key: string;
  /** Only facts known at or before this instant are visible. */
  knowledgeTime: Instant;
  /** Inclusive lower bound on valid time. */
  from?: Instant;
  /** Inclusive upper bound on valid time. */
  to?: Instant;
}

export interface Observation<T> {
  validTime: Instant;
  value: T;
  /** When the value being returned became known. */
  knownAt: Instant;
  source?: string;
}

function compare(a: Instant, b: Instant): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An append-only bitemporal store.
 *
 * In production this is Iceberg over Parquet, read through DuckDB, with a
 * snapshot ID pinning the read. The semantics are the same and are what the
 * tests here protect; `SnapshotStore` in `snapshots.ts` is the seam.
 */
export class BitemporalStore<T = number> {
  private readonly facts = new Map<string, Fact<T>[]>();

  /** Appends a fact. Nothing is ever overwritten. */
  append(fact: Fact<T>): void {
    const existing = this.facts.get(fact.key);
    if (existing) existing.push(fact);
    else this.facts.set(fact.key, [fact]);
  }

  appendAll(facts: Iterable<Fact<T>>): void {
    for (const fact of facts) this.append(fact);
  }

  get size(): number {
    let total = 0;
    for (const list of this.facts.values()) total += list.length;
    return total;
  }

  get keys(): string[] {
    return [...this.facts.keys()];
  }

  /**
   * The series as it stood at `knowledgeTime`.
   *
   * For each valid time, the visible value is the latest record whose
   * knowledge time is at or before the query — the number that was on the
   * screen that morning, not the one that replaced it later.
   */
  asOf(query: AsOfQuery): Observation<T>[] {
    const list = this.facts.get(query.key);
    if (!list) return [];

    const latest = new Map<Instant, Fact<T>>();
    for (const fact of list) {
      if (compare(fact.knowledgeTime, query.knowledgeTime) > 0) continue;
      if (query.from !== undefined && compare(fact.validTime, query.from) < 0) continue;
      if (query.to !== undefined && compare(fact.validTime, query.to) > 0) continue;

      const held = latest.get(fact.validTime);
      // Ties on knowledge time keep the later append: an intra-instant
      // correction is still a correction.
      if (!held || compare(fact.knowledgeTime, held.knowledgeTime) >= 0) {
        latest.set(fact.validTime, fact);
      }
    }

    return [...latest.values()]
      .sort((a, b) => compare(a.validTime, b.validTime))
      .map((fact) => {
        const observation: Observation<T> = {
          validTime: fact.validTime,
          value: fact.value,
          knownAt: fact.knowledgeTime,
        };
        if (fact.source !== undefined) observation.source = fact.source;
        return observation;
      });
  }

  /** The single value in force at `validTime`, as known at `knowledgeTime`. */
  valueAt(key: string, validTime: Instant, knowledgeTime: Instant): Observation<T> | undefined {
    const observations = this.asOf({ key, knowledgeTime, to: validTime });
    return observations[observations.length - 1];
  }

  /**
   * Every version of one fact, oldest knowledge first.
   *
   * This is what makes a restatement inspectable rather than a rumour: the
   * analyst can see that Q3 revenue was 18.1, then 17.9, and when each was
   * true on the tape.
   */
  history(key: string, validTime: Instant): Fact<T>[] {
    return (this.facts.get(key) ?? [])
      .filter((fact) => fact.validTime === validTime)
      .sort((a, b) => compare(a.knowledgeTime, b.knowledgeTime));
  }

  /** Valid times whose value was changed after first being reported. */
  restatements(key: string): Array<{ validTime: Instant; versions: number }> {
    const byValid = new Map<Instant, number>();
    for (const fact of this.facts.get(key) ?? []) {
      byValid.set(fact.validTime, (byValid.get(fact.validTime) ?? 0) + 1);
    }
    return [...byValid.entries()]
      .filter(([, versions]) => versions > 1)
      .map(([validTime, versions]) => ({ validTime, versions }))
      .sort((a, b) => compare(a.validTime, b.validTime));
  }

  /** The latest knowledge time in the store, which is its effective "now". */
  get latestKnowledgeTime(): Instant | undefined {
    let latest: Instant | undefined;
    for (const list of this.facts.values()) {
      for (const fact of list) {
        if (latest === undefined || compare(fact.knowledgeTime, latest) > 0) {
          latest = fact.knowledgeTime;
        }
      }
    }
    return latest;
  }
}

/**
 * Compares a point-in-time read against the same read taken today.
 *
 * Where they differ, the series has been restated, and a backtest that used
 * today's numbers was trading on information it could not have had. Surfacing
 * that is more useful than preventing it silently: the analyst wants to know
 * which of their names restate.
 */
export interface LeakReport<T> {
  key: string;
  asOf: Instant;
  /** Valid times whose value differs between the two reads. */
  differences: Array<{ validTime: Instant; pointInTime: T; latest: T }>;
}

export function detectRestatementLeak<T>(
  store: BitemporalStore<T>,
  key: string,
  knowledgeTime: Instant,
  latestKnowledgeTime: Instant,
): LeakReport<T> {
  const historical = new Map(
    store.asOf({ key, knowledgeTime }).map((o) => [o.validTime, o.value] as const),
  );
  const current = store.asOf({ key, knowledgeTime: latestKnowledgeTime });

  const differences: LeakReport<T>['differences'] = [];
  for (const observation of current) {
    if (!historical.has(observation.validTime)) continue;
    const pointInTime = historical.get(observation.validTime) as T;
    if (!Object.is(pointInTime, observation.value)) {
      differences.push({
        validTime: observation.validTime,
        pointInTime,
        latest: observation.value,
      });
    }
  }

  return { key, asOf: knowledgeTime, differences };
}
