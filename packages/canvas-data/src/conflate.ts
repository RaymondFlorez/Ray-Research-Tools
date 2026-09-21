/**
 * Server-side conflation (PRD 7.3).
 *
 * > Live subscribed series per canvas | 2,000 | NATS subject filtering,
 * > **server-side conflation to 4Hz max per series**
 *
 * > A browser subscribed to 2,000 series receives at most 8,000 updates/sec of
 * > pre-conflated deltas over a single WebTransport connection, binary-encoded,
 * > not 1.5M raw ticks.
 *
 * The arithmetic is the easy part: 2,000 series at 4Hz is 8,000 updates a
 * second, and the tick rate above it does not matter because the output rate
 * does not depend on the input rate. What takes care is *what conflation means
 * for each field*, and the natural implementation gets it wrong in a way that
 * shows up as a wrong number rather than as a slow one.
 *
 * ## Conflation is not "keep the last"
 *
 * For a price it is. The last trade in the window is the price; the ones before
 * it are superseded, which is exactly what conflation is for.
 *
 * For **traded volume it is a sum**. Two hundred ticks arrive in a 250ms window
 * and each carries the size of its trade. Keeping the last one reports the size
 * of the last trade as the volume of the window, which under-reports by however
 * much traded in the other 199 — silently, and by an amount that grows with how
 * busy the tape is. A volume that is wrong when the market is quiet and very
 * wrong when it is not is worse than no volume.
 *
 * For a **high it is a maximum and for a low a minimum**, and the point is the
 * same one min/max decimation makes about a chart: the extreme is often on a
 * tick that conflation drops, and it is often the tick the analyst cares about.
 * A spike that happened is not less real for having happened between frames.
 *
 * So a field declares how it combines, and `sum`, `max`, `min` and `first` all
 * exist because each of them is the right answer for something that is
 * genuinely quoted.
 *
 * ## The clock is per series, and it is a grid rather than a stopwatch
 *
 * A single global timer would emit every series at the same instant, which
 * turns 2,000 smooth streams into a 2,000-message spike four times a second —
 * the same total rate and a much worse shape, since the client has to parse and
 * lay out all of it in one frame. Each series is anchored to its own first
 * tick, so the phases spread across the window.
 *
 * Within a series the due times sit on a fixed grid from that anchor, rather
 * than being measured from whichever tick opened the window. The difference
 * looks like nothing and is a drift: a window that starts when the next tick
 * arrives lasts `window + gap`, the gap accumulates, and a series ticking at
 * 1kHz emits three times a second instead of four. Under the cap, so not a
 * breach — and a quarter of the updates missing for no reason anybody chose.
 * The grid also recovers cleanly from silence: a series that stops for ten
 * seconds and ticks again lands on the next slot boundary rather than firing
 * immediately or working through forty stale ones.
 */

/** How a field combines when several ticks fall in one window. */
export type Combine = 'last' | 'first' | 'sum' | 'max' | 'min';

/** What each field of a series means when conflated. */
export type FieldSpec = Record<string, Combine>;

/** The default for a quoted instrument: price last, size summed, extremes kept. */
export const TRADE_FIELDS: FieldSpec = {
  price: 'last',
  size: 'sum',
  high: 'max',
  low: 'min',
  open: 'first',
};

export interface Tick {
  seriesId: string;
  /** Milliseconds since the epoch. */
  t: number;
  values: Record<string, number>;
}

export interface Update {
  seriesId: string;
  /** Timestamp of the last tick folded in. */
  t: number;
  values: Record<string, number>;
  /** Ticks this update stands for, including the one that opened the window. */
  ticks: number;
}

/** 4Hz: the PRD's per-series cap. */
export const MAX_HZ = 4;
export const WINDOW_MS = 1000 / MAX_HZ;

interface Pending {
  seriesId: string;
  t: number;
  values: Record<string, number>;
  ticks: number;
  dueAt: number;
}

export interface ConflatorOptions {
  /** Per-series field semantics, by series id. Falls back to `defaultFields`. */
  fields?: Record<string, FieldSpec>;
  defaultFields?: FieldSpec;
  windowMs?: number;
}

/**
 * Folds a tick stream down to at most one update per series per window.
 *
 * Push ticks in with `accept`, take the ones that are due out with `drain`. The
 * split exists because the caller owns the clock: a server drains on a timer, a
 * test drains at times it chooses, and a conflator that woke itself up could be
 * tested only by waiting.
 */
export class Conflator {
  private readonly pending = new Map<string, Pending>();
  /** First tick time per series: the phase its emission grid is anchored to. */
  private readonly anchor = new Map<string, number>();
  private readonly fields: Record<string, FieldSpec>;
  private readonly defaultFields: FieldSpec;
  private readonly windowMs: number;

  /** Ticks accepted since construction, for the compression figure. */
  private accepted = 0;
  private emitted = 0;

  constructor(options: ConflatorOptions = {}) {
    this.fields = options.fields ?? {};
    this.defaultFields = options.defaultFields ?? TRADE_FIELDS;
    this.windowMs = options.windowMs ?? WINDOW_MS;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get stats(): { accepted: number; emitted: number; ratio: number } {
    return {
      accepted: this.accepted,
      emitted: this.emitted,
      ratio: this.emitted === 0 ? Infinity : this.accepted / this.emitted,
    };
  }

  private specFor(seriesId: string): FieldSpec {
    return this.fields[seriesId] ?? this.defaultFields;
  }

  accept(tick: Tick): void {
    this.accepted += 1;
    const existing = this.pending.get(tick.seriesId);

    if (existing === undefined) {
      // The window closes on this series' own grid, anchored at its first tick.
      // Anchoring per series is what spreads the load across the window; using
      // a grid rather than "a window from now" is what stops the period
      // drifting out to `window + gap` on every cycle.
      let anchor = this.anchor.get(tick.seriesId);
      if (anchor === undefined) {
        anchor = tick.t;
        this.anchor.set(tick.seriesId, anchor);
      }
      const slot = Math.floor((tick.t - anchor) / this.windowMs) + 1;
      this.pending.set(tick.seriesId, {
        seriesId: tick.seriesId,
        t: tick.t,
        values: { ...tick.values },
        ticks: 1,
        dueAt: anchor + slot * this.windowMs,
      });
      return;
    }

    const spec = this.specFor(tick.seriesId);
    for (const [field, value] of Object.entries(tick.values)) {
      const combine = spec[field] ?? 'last';
      const held = existing.values[field];
      if (held === undefined) {
        existing.values[field] = value;
        continue;
      }
      switch (combine) {
        case 'sum':
          existing.values[field] = held + value;
          break;
        case 'max':
          existing.values[field] = Math.max(held, value);
          break;
        case 'min':
          existing.values[field] = Math.min(held, value);
          break;
        case 'first':
          break;
        default:
          existing.values[field] = value;
      }
    }
    existing.ticks += 1;
    // A late tick does not pull the window backwards.
    if (tick.t > existing.t) existing.t = tick.t;
  }

  /**
   * Take every series whose window has closed by `now`.
   *
   * Sorted by due time so the oldest goes first: under a backlog the series
   * that has been waiting longest is the one whose update is most stale.
   */
  drain(now: number): Update[] {
    const due: Pending[] = [];
    for (const entry of this.pending.values()) {
      if (entry.dueAt <= now) due.push(entry);
    }
    due.sort((a, b) => a.dueAt - b.dueAt || (a.seriesId < b.seriesId ? -1 : 1));

    const updates: Update[] = [];
    for (const entry of due) {
      this.pending.delete(entry.seriesId);
      updates.push({
        seriesId: entry.seriesId,
        t: entry.t,
        values: entry.values,
        ticks: entry.ticks,
      });
    }
    this.emitted += updates.length;
    return updates;
  }

  /** Everything still held, regardless of due time. For a shutdown or a test. */
  flush(): Update[] {
    const updates: Update[] = [];
    for (const entry of this.pending.values()) {
      updates.push({
        seriesId: entry.seriesId,
        t: entry.t,
        values: entry.values,
        ticks: entry.ticks,
      });
    }
    this.pending.clear();
    this.emitted += updates.length;
    updates.sort((a, b) => (a.seriesId < b.seriesId ? -1 : 1));
    return updates;
  }
}

/** The PRD's fan-out bound: series times the per-series rate. */
export function maxUpdatesPerSecond(series: number, hz = MAX_HZ): number {
  return series * hz;
}
