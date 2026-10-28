/**
 * The point-in-time guard (PRD 5.8).
 *
 * "Point-in-time data enforced at the `data-access` layer: a backtest at date T
 * cannot see any record whose knowledge-time exceeds T. This is enforced by
 * Iceberg snapshot pinning, not by convention."
 *
 * Convention is the failure mode this exists to remove. Every leaky backtest
 * ever written was written by someone who *intended* not to look ahead; the
 * lookahead came from a join, a fill-forward, or a restated field nobody
 * thought of as data. So the strategy is never handed a series. It is handed a
 * reader that physically cannot return a record stamped after the current bar,
 * and a strategy that tries gets an error naming the record rather than a
 * number.
 */

export interface Record<T> {
  /** The date the fact is about. */
  validTime: string;
  /** The moment it became knowable — a restatement carries a later one. */
  knowledgeTime: string;
  value: T;
}

export class LookAheadError extends Error {
  constructor(
    readonly key: string,
    readonly asOf: string,
    readonly knowledgeTime: string,
  ) {
    super(
      `look-ahead: "${key}" was not knowable on ${asOf} — that record was stamped ` +
        `${knowledgeTime}. The backtest asked for a fact from its own future.`,
    );
    this.name = 'LookAheadError';
  }
}

/**
 * Whether `later`, added after `held` for the same valid time, replaces it:
 * known later, or known at the same instant — an intra-instant correction is
 * still a correction. canvas-data's `BitemporalStore` and the Go data plane
 * break the tie the same way, and `loadHistory` adds versions in their order.
 */
function supersedes(later: Record<number>, held: Record<number>): boolean {
  return later.knowledgeTime >= held.knowledgeTime;
}

/**
 * A read-only view of history, frozen at one instant.
 *
 * Handed to the strategy in place of the data itself. It has no method that
 * takes a date, so there is no way to ask about tomorrow even by accident.
 */
export class AsOfView {
  constructor(
    private readonly series: ReadonlyMap<string, ReadonlyArray<Record<number>>>,
    readonly asOf: string,
  ) {}

  /** The latest value for `key` that was knowable on this bar. */
  latest(key: string): number | undefined {
    const history = this.series.get(key);
    if (!history) return undefined;
    let best: Record<number> | undefined;
    for (const record of history) {
      if (record.validTime > this.asOf) continue;
      if (record.knowledgeTime > this.asOf) continue;
      if (!best || record.validTime > best.validTime ||
        (record.validTime === best.validTime && supersedes(record, best))) {
        best = record;
      }
    }
    return best?.value;
  }

  /** The last `count` knowable values, oldest first. */
  window(key: string, count: number): number[] {
    const history = this.series.get(key);
    if (!history) return [];
    // One value per valid time — the newest knowable revision of each.
    const byDate = new Map<string, Record<number>>();
    for (const record of history) {
      if (record.validTime > this.asOf || record.knowledgeTime > this.asOf) continue;
      const held = byDate.get(record.validTime);
      if (!held || supersedes(record, held)) byDate.set(record.validTime, record);
    }
    return [...byDate.values()]
      .sort((a, b) => (a.validTime < b.validTime ? -1 : a.validTime > b.validTime ? 1 : 0))
      .slice(-count)
      .map((r) => r.value);
  }

  /**
   * The names in a universe as of this bar, delisted ones included.
   *
   * "Survivorship handling: universes resolve as of the historical date,
   * including delisted names with their delisting returns." A universe built
   * from today's index members is the most common look-ahead there is, and the
   * one least likely to be noticed, because the resulting equity curve looks
   * plausible rather than impossible.
   */
  members(universe: ReadonlyArray<{ symbol: string; from: string; until?: string }>): string[] {
    return universe
      .filter((m) => m.from <= this.asOf && (m.until === undefined || m.until > this.asOf))
      .map((m) => m.symbol);
  }
}

/** History, with a reader that can only look backwards. */
export class History {
  private readonly series = new Map<string, Record<number>[]>();

  add(key: string, record: Record<number>): void {
    const list = this.series.get(key) ?? [];
    list.push(record);
    this.series.set(key, list);
  }

  /**
   * Adds a series where each value became knowable on the day it describes.
   *
   * The common case, and the one worth making easy — a price is known the day
   * it prints. A restatement is added with `add` and its own knowledge time.
   */
  addSeries(key: string, points: ReadonlyArray<{ date: string; value: number }>): void {
    for (const point of points) {
      this.add(key, { validTime: point.date, knowledgeTime: point.date, value: point.value });
    }
  }

  /**
   * Records that `symbol` delisted on `date`, returning `delistingReturn` from
   * its last traded price to what holders actually received (CRSP's DLRET).
   *
   * The backtest settles any position in the name at that value on that date.
   * A name whose prices simply stop, with no delisting recorded, is marked at
   * its last print and warned about — never silently dropped.
   */
  delist(symbol: string, date: string, delistingReturn: number, knowledgeTime: string = date): void {
    if (!(delistingReturn >= -1)) {
      throw new RangeError(`delisting return for ${symbol} is ${delistingReturn}; a holder cannot lose more than everything`);
    }
    this.add(`delist:${symbol}`, { validTime: date, knowledgeTime, value: delistingReturn });
  }

  viewAt(asOf: string): AsOfView {
    return new AsOfView(this.series, asOf);
  }

  /** Every valid time present, sorted — the backtest's clock. */
  dates(): string[] {
    const all = new Set<string>();
    for (const history of this.series.values()) {
      for (const record of history) all.add(record.validTime);
    }
    return [...all].sort();
  }

  /**
   * The unguarded read, for the engine itself rather than the strategy.
   *
   * The engine has to settle a trade at tomorrow's price, which is not
   * look-ahead — it is the passage of time. The strategy never gets this.
   */
  actualAt(key: string, date: string): number | undefined {
    const history = this.series.get(key);
    if (!history) return undefined;
    let best: Record<number> | undefined;
    for (const record of history) {
      if (record.validTime !== date) continue;
      if (!best || supersedes(record, best)) best = record;
    }
    return best?.value;
  }
}

/**
 * Where a backtest's history can come from: anything that returns every
 * version in a valid-time range, with the versions the caller may not see
 * listed rather than dropped. canvas-data's `RemotePointInTime` — the Go data
 * plane on Postgres — is one.
 */
export interface VersionSource {
  versions(
    key: string,
    range: { from?: string; to?: string },
  ): Promise<{
    versions: ReadonlyArray<{ validTime: string; knowledgeTime: string; value: number }>;
    withheld: ReadonlyArray<{ validTime: string; knowledgeTime: string; decision: { message: string } }>;
  }>;
}

export class IncompleteHistory extends Error {
  constructor(
    readonly key: string,
    readonly withheld: ReadonlyArray<{ validTime: string; knowledgeTime: string; decision: { message: string } }>,
  ) {
    const first = withheld[0];
    super(
      `"${key}" has ${withheld.length} version(s) this user may not see` +
        (first ? `, the first for ${first.validTime} known ${first.knowledgeTime}: ${first.decision.message.replace(/\.$/, '')}` : '') +
        '. A backtest without them would use a superseded value on every bar after each one.',
    );
    this.name = 'IncompleteHistory';
  }
}

/**
 * Loads every version of `keys` into a History, or refuses.
 *
 * All versions, because the guard is the backtest's own `AsOfView`: each bar
 * must see what was known on that bar, and that needs the versions known
 * later too, to leave them out. And refuses outright when any version in range
 * is withheld from this user: a backtest run on the rest would read the last
 * version it was allowed as current long after it was replaced, and nothing
 * in the result would say so. The entitlement is the user's; the refusal is
 * this function's.
 */
export async function loadHistory(
  source: VersionSource,
  keys: readonly string[],
  range: { from?: string; to?: string } = {},
): Promise<History> {
  const history = new History();
  for (const key of keys) {
    const { versions, withheld } = await source.versions(key, range);
    if (withheld.length > 0) throw new IncompleteHistory(key, withheld);
    for (const v of versions) history.add(key, { validTime: v.validTime, knowledgeTime: v.knowledgeTime, value: v.value });
  }
  return history;
}
