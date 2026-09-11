import { describe, expect, it } from 'vitest';
import {
  PRESENCE_HZ,
  PRESENCE_INTERVAL_MS,
  PRESENCE_TIMEOUT_MS,
  PresenceRegistry,
  PresenceThrottle,
  colorForClient,
  type PresenceState,
} from '../src/presence.js';

const self = { clientId: 7, name: 'Maya', color: '#c0392b' };

describe('cursor throttle (PRD 7.3: 20Hz)', () => {
  it('caps cursor movement at the interval', () => {
    const throttle = new PresenceThrottle(self);
    expect(PRESENCE_INTERVAL_MS).toBe(1000 / PRESENCE_HZ);

    expect(throttle.offer({ cursor: { x: 0, y: 0 } }, 0)).not.toBeNull();
    // A pointer at 240Hz would offer a dozen positions inside one interval.
    for (let t = 1; t < PRESENCE_INTERVAL_MS; t += 4) {
      expect(throttle.offer({ cursor: { x: t, y: 0 } }, t)).toBeNull();
    }
    expect(throttle.offer({ cursor: { x: 99, y: 0 } }, PRESENCE_INTERVAL_MS)).not.toBeNull();
  });

  it('publishes about twenty times a second under a continuous drag', () => {
    const throttle = new PresenceThrottle(self);
    let published = 0;
    // One second of pointer events at 240Hz.
    for (let i = 0; i <= 240; i++) {
      const now = (i / 240) * 1000;
      if (throttle.offer({ cursor: { x: i, y: i } }, now)) published += 1;
    }
    expect(published).toBeLessThanOrEqual(PRESENCE_HZ + 1);
    expect(published).toBeGreaterThanOrEqual(PRESENCE_HZ - 1);
  });

  it('never delays a selection change, which is a discrete event', () => {
    const throttle = new PresenceThrottle(self);
    throttle.offer({ cursor: { x: 0, y: 0 } }, 0);

    // Mid-interval: a cursor move is held, a selection is not.
    expect(throttle.offer({ cursor: { x: 1, y: 1 } }, 5)).toBeNull();
    const selected = throttle.offer({ cursor: { x: 2, y: 2 }, selection: ['nvda'] }, 6);
    expect(selected?.selection).toEqual(['nvda']);
  });

  it('never delays the viewport, so "jump to me" lands immediately', () => {
    const throttle = new PresenceThrottle(self);
    throttle.offer({ cursor: { x: 0, y: 0 } }, 0);
    expect(throttle.offer({ cursor: { x: 1, y: 0 } }, 4)).toBeNull();
    expect(throttle.offer({ viewport: { x: 500, y: 100, scale: 2 } }, 5)).not.toBeNull();
  });

  it('flushes a held position once the interval passes, so movement that stops still lands', () => {
    const throttle = new PresenceThrottle(self);
    throttle.offer({ cursor: { x: 0, y: 0 } }, 0);
    expect(throttle.offer({ cursor: { x: 40, y: 40 } }, 10)).toBeNull();

    // Nothing further is offered: the pointer stopped mid-interval.
    expect(throttle.flush(20)).toBeNull();
    const flushed = throttle.flush(PRESENCE_INTERVAL_MS + 1);
    expect(flushed?.cursor).toEqual({ x: 40, y: 40 });
    // Only the newest held position is sent, never the stale ones behind it.
    expect(throttle.flush(1_000)).toBeNull();
  });

  it('carries forward what the patch does not mention', () => {
    const throttle = new PresenceThrottle(self);
    throttle.offer({ cursor: { x: 1, y: 1 }, selection: ['a'] }, 0);
    const next = throttle.offer({ viewport: { x: 0, y: 0, scale: 1 } }, 100);
    expect(next?.selection).toEqual(['a']);
    expect(next?.cursor).toEqual({ x: 1, y: 1 });
    expect(next?.name).toBe('Maya');
  });
});

describe('peer registry', () => {
  function peer(clientId: number, at: number, over: Partial<PresenceState> = {}): PresenceState {
    return { clientId, name: `analyst-${clientId}`, color: '#000', selection: [], at, ...over };
  }

  it('tracks peers and reports who is here', () => {
    const registry = new PresenceRegistry();
    registry.apply(peer(1, 0));
    registry.apply(peer(2, 0));
    expect(registry.active(0)).toHaveLength(2);

    registry.remove(1);
    expect(registry.size).toBe(1);
  });

  it('is last-write-wins per client, but never rewinds on an out-of-order packet', () => {
    const registry = new PresenceRegistry();
    registry.apply(peer(1, 100, { cursor: { x: 10, y: 10 } }));
    registry.apply(peer(1, 200, { cursor: { x: 20, y: 20 } }));
    expect(registry.active(200)[0]?.cursor).toEqual({ x: 20, y: 20 });

    // A packet from before the one already applied must not take effect.
    registry.apply(peer(1, 150, { cursor: { x: 15, y: 15 } }));
    expect(registry.active(200)[0]?.cursor).toEqual({ x: 20, y: 20 });
  });

  it('drops peers that have gone quiet', () => {
    const registry = new PresenceRegistry();
    registry.apply(peer(1, 0));
    registry.apply(peer(2, PRESENCE_TIMEOUT_MS));

    const now = PRESENCE_TIMEOUT_MS + 1;
    expect(registry.active(now).map((p) => p.clientId)).toEqual([2]);
    expect(registry.prune(now)).toBe(1);
    expect(registry.size).toBe(1);
  });

  it('gives each client a stable, distinguishable colour', () => {
    expect(colorForClient(3)).toBe(colorForClient(3));
    const colors = new Set(Array.from({ length: 12 }, (_, i) => colorForClient(i)));
    // Twelve concurrent editors is the PRD target; they should not collide.
    expect(colors.size).toBe(12);
    expect(colorForClient(-5)).toBeTruthy();
  });
});
