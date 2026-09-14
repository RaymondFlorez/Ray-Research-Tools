/**
 * The degradation ladder (PRD 7.4).
 *
 * Six rungs in a defined order, and one rule underneath all of them:
 *
 * "**The system never shows a number without telling the truth about where it
 * came from and how old it is.** A stale number presented confidently is worse
 * than no number, because the analyst will trade on it."
 *
 * A rule stated that strongly should not be a convention that every render
 * path remembers to follow. So `present()` is the only way to produce a
 * displayable value in this package, and it cannot be called without a source
 * and an as-of: there is no overload that omits them, and a blank one is
 * rejected at runtime for the JavaScript callers that types do not reach.
 * Degrading a subsystem changes the badge and the age, never whether they
 * exist.
 */

export type Subsystem =
  | 'frontier_vendor'
  | 'gpu_fleet'
  | 'realtime_feed'
  | 'warehouse'
  | 'collab'
  | 'sandbox';

export type Health = 'up' | 'degraded' | 'down';

export type SystemHealth = Record<Subsystem, Health>;

export const ALL_UP: SystemHealth = {
  frontier_vendor: 'up',
  gpu_fleet: 'up',
  realtime_feed: 'up',
  warehouse: 'up',
  collab: 'up',
  sandbox: 'up',
};

export interface Rung {
  /** Position in the PRD's order. Lower degrades first. */
  level: number;
  subsystem: Subsystem;
  /** What the system does instead. */
  response: string;
  /** What the affected nodes show. Never absent: silent substitution is the failure. */
  badge: string;
  /** Capability actually lost, in the analyst's terms. */
  lost: string;
}

/** PRD 7.4, in order. */
export const LADDER: readonly Rung[] = [
  {
    level: 1,
    subsystem: 'frontier_vendor',
    response: 'route to the 70B open-weight fleet',
    badge: 'reduced capability: open-weight model',
    lost: 'long-context comprehension and the independent critique tier',
  },
  {
    level: 2,
    subsystem: 'gpu_fleet',
    response: 'local 3B handles classification and autocomplete; heavy tasks queue',
    badge: 'queued: position shown',
    lost: 'immediate results for anything past classification',
  },
  {
    level: 3,
    subsystem: 'realtime_feed',
    response: 'show last value with elapsed time',
    badge: 'stale data',
    lost: 'live prices; the number on screen is the last one that arrived',
  },
  {
    level: 4,
    subsystem: 'warehouse',
    response: "serve from the client's local cache where the data is present",
    badge: 'cached at timestamp',
    lost: 'anything outside what the client already cached',
  },
  {
    level: 5,
    subsystem: 'collab',
    response: 'canvas continues offline against local storage; edits merge on reconnect',
    badge: 'offline: edits queued',
    lost: 'other editors and presence',
  },
  {
    level: 6,
    subsystem: 'sandbox',
    response: 'code nodes fall back to the in-browser runtime, otherwise queue',
    badge: 'reduced capability: in-browser runtime',
    lost: 'anything the in-browser runtime cannot run',
  },
];

/**
 * The rungs currently in effect, in the ladder's order.
 *
 * Order matters to the analyst, not to the machine: the card that lists what
 * is degraded is read top to bottom, and a list that reorders itself by
 * whichever subsystem failed most recently is a list nobody learns to read.
 */
export function active(health: SystemHealth): Rung[] {
  return LADDER.filter((rung) => health[rung.subsystem] !== 'up');
}

/** Whether a degraded system can still answer at all. */
export function stillAnswers(health: SystemHealth): boolean {
  // Everything except a total loss of both model tiers leaves some answer
  // available, because the deterministic Critic and every compute node run
  // without a model at all.
  return !(health.frontier_vendor === 'down' && health.gpu_fleet === 'down');
}

// ---------------------------------------------------------------------------
// The rule underneath all six
// ---------------------------------------------------------------------------

export class UntruthfulPresentation extends Error {
  constructor(missing: string) {
    super(`a displayed value must state ${missing}`);
    this.name = 'UntruthfulPresentation';
  }
}

export interface Origin {
  /** Where the number came from, in the analyst's terms, not the system's. */
  source: string;
  /** When the underlying data was true. */
  asof: string;
  /** Epoch millis of `asof`, for the age. */
  asofMs: number;
}

export interface Presented {
  value: number | string;
  source: string;
  asof: string;
  ageMs: number;
  /** Set whenever a rung is in effect for this value's path. */
  badge?: string;
  /** What the analyst reads under the number. */
  caption: string;
}

/**
 * The only way to put a number on screen.
 *
 * Takes the value and its origin together, because the two travelling
 * separately is exactly how a stale number ends up next to a fresh timestamp.
 */
export function present(
  value: number | string,
  origin: Origin,
  now: number,
  rung?: Rung,
): Presented {
  if (origin.source.trim() === '') throw new UntruthfulPresentation('where it came from');
  if (origin.asof.trim() === '' || !Number.isFinite(origin.asofMs)) {
    throw new UntruthfulPresentation('how old it is');
  }
  const ageMs = Math.max(0, now - origin.asofMs);
  const caption = `${origin.source} · ${describeAge(ageMs)}${rung ? ` · ${rung.badge}` : ''}`;
  return {
    value,
    source: origin.source,
    asof: origin.asof,
    ageMs,
    ...(rung ? { badge: rung.badge } : {}),
    caption,
  };
}

function describeAge(ms: number): string {
  if (ms < 2000) return 'live';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s old`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

/** The rung governing a value served by a given subsystem, if any. */
export function rungFor(health: SystemHealth, subsystem: Subsystem): Rung | undefined {
  if (health[subsystem] === 'up') return undefined;
  return LADDER.find((r) => r.subsystem === subsystem);
}
