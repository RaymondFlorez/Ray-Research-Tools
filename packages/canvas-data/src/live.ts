/**
 * Live tiles over the data plane's stream (PRD 3.6, 7.3, 7.4).
 *
 * `services/dataplane` sends three kinds of event on `/v1/stream`: `update`,
 * a conflated window for one instrument; `blocked`, once per instrument the
 * caller may not see; and `health`, the state of every instrument the caller
 * receives — live, stale with the time since its last update, or recovering
 * after a sequence gap. This module turns that stream into what each tile
 * shows, and nothing else: no network, no drawing.
 *
 * Three states a tile is never allowed to fake:
 *
 *   - **Blocked is not empty.** A tile the caller is not licensed for shows
 *     the reason, and holds no value even if one arrived before the licence
 *     changed (PRD 7.2: "an entitlement-blocked state rather than a stale
 *     cached value").
 *   - **Stale is not live.** The server says when a series stopped; between
 *     its health reports the tile's elapsed time keeps counting on the local
 *     clock, so a feed that dies does not leave a number frozen at "2s ago"
 *     (PRD 7.4: "never a silently frozen number").
 *   - **Recovering is not live either.** After a gap the value may be missing
 *     ticks, and the tile says so until the server clears it.
 */

/** One Server-Sent Event: its name and its data. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Splits a chunk of an event stream into whole events, returning what is left
 * over for the next chunk. A chunk boundary can fall anywhere — mid-line,
 * mid-field — so nothing is emitted until its blank line has arrived.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** The data plane's per-series health. */
export type FeedState = 'live' | 'stale' | 'recovering';

export interface TileView {
  instrument: string;
  /**
   * `value`: a number to show. `blocked`: the caller may not see it.
   * `waiting`: nothing has arrived yet — which is not zero.
   */
  kind: 'value' | 'blocked' | 'waiting';
  values?: Record<string, number>;
  /** Ticks the last update stood for. */
  ticks?: number;
  /** When the value was true, from the server's clock (epoch ms). */
  asOfMs?: number;
  state: FeedState;
  /** Time since the series last updated, as best known now. */
  elapsedMs?: number;
  reason?: string;
}

interface Held {
  values?: Record<string, number>;
  ticks?: number;
  asOfMs?: number;
  state: FeedState;
  serverElapsedMs?: number;
  /** Local time the last health report arrived, for counting on between reports. */
  healthAt?: number;
  /** Local time the last update arrived. */
  updateAt?: number;
  reason?: string;
  blocked?: { reason: string; message: string };
}

/** Folds the stream into tiles. */
export class LiveTiles {
  private readonly held = new Map<string, Held>();
  private updates = 0;

  /** Applies one event, at local time `now` (ms). Unknown events are ignored. */
  apply(e: SseEvent, now: number): void {
    if (e.event === 'update') {
      const u = JSON.parse(e.data) as { seriesId: string; t: number; values: Record<string, number>; ticks: number };
      const h = this.get(u.seriesId);
      // A licence that lapsed mid-stream keeps the tile blocked: the server
      // stops sending, and nothing that arrived earlier is shown in its place.
      if (h.blocked) return;
      h.values = u.values;
      h.ticks = u.ticks;
      h.asOfMs = u.t;
      h.updateAt = now;
      this.updates += 1;
    } else if (e.event === 'blocked') {
      const b = JSON.parse(e.data) as { instrument: string; decision: { reason: string; message: string } };
      const h = this.get(b.instrument);
      h.blocked = { reason: b.decision.reason, message: b.decision.message };
      delete h.values;
      delete h.ticks;
      delete h.asOfMs;
    } else if (e.event === 'health') {
      const list = JSON.parse(e.data) as Array<{ instrument: string; state: FeedState; elapsedMs: number; reason?: string }>;
      for (const report of list) {
        const h = this.get(report.instrument);
        h.state = report.state;
        h.serverElapsedMs = report.elapsedMs;
        h.healthAt = now;
        if (report.reason !== undefined) h.reason = report.reason;
        else delete h.reason;
      }
    }
  }

  /** What one tile shows at local time `now`. */
  tile(instrument: string, now: number): TileView {
    const h = this.held.get(instrument);
    if (!h) return { instrument, kind: 'waiting', state: 'live' };
    if (h.blocked) return { instrument, kind: 'blocked', state: h.state, reason: h.blocked.message };
    if (!h.values) return { instrument, kind: 'waiting', state: h.state };
    // The server's elapsed time at its last report, plus the local time since
    // — unless an update arrived after that report, which restarts the count.
    let elapsedMs: number | undefined;
    if (h.healthAt !== undefined && h.serverElapsedMs !== undefined && (h.updateAt === undefined || h.healthAt >= h.updateAt)) {
      elapsedMs = h.serverElapsedMs + (now - h.healthAt);
    } else if (h.updateAt !== undefined) {
      elapsedMs = now - h.updateAt;
    }
    const view: TileView = { instrument, kind: 'value', values: { ...h.values }, state: h.state };
    if (h.ticks !== undefined) view.ticks = h.ticks;
    if (h.asOfMs !== undefined) view.asOfMs = h.asOfMs;
    if (elapsedMs !== undefined) view.elapsedMs = elapsedMs;
    if (h.reason !== undefined) view.reason = h.reason;
    return view;
  }

  get updatesApplied(): number {
    return this.updates;
  }

  private get(instrument: string): Held {
    let h = this.held.get(instrument);
    if (!h) {
      h = { state: 'live' };
      this.held.set(instrument, h);
    }
    return h;
  }
}
