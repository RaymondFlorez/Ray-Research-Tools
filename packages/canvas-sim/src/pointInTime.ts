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
        (record.validTime === best.validTime && record.knowledgeTime > best.knowledgeTime)) {
        best = record;
      }
    }
    return best?.value;
  }

  /** The last `count` knowable values, oldest first. */
  window(key: string, count: number): number[] {
    const history = this.series.get(key);
    if (!history) return [];
    const visible = history
      .filter((r) => r.validTime <= this.asOf && r.knowledgeTime <= this.asOf)
      .sort((a, b) => (a.validTime < b.validTime ? -1 : a.validTime > b.validTime ? 1 : 0));

    // One value per valid time — the newest knowable revision of each.
    const byDate = new Map<string, number>();
    for (const record of visible) byDate.set(record.validTime, record.value);
    return [...byDate.values()].slice(-count);
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
      if (!best || record.knowledgeTime > best.knowledgeTime) best = record;
    }
    return best?.value;
  }
}
