import { describe, expect, it } from 'vitest';
import type { BindingState, LOD, NodeStatus } from '@picasso/canvas-core';
import { nodeStyle, signaturesDistinctAt, statusColor } from '../src/style.js';
import { darkTheme, lightTheme } from '../src/theme.js';

const LODS: LOD[] = [0, 1, 2, 3];

describe('binding visual signatures (PRD 3.2, guardrail #2)', () => {
  it('keeps the three binding states distinguishable at every LOD, in both themes', () => {
    for (const theme of [lightTheme, darkTheme]) {
      for (const lod of LODS) {
        expect(signaturesDistinctAt(lod, theme)).toBe(true);
      }
    }
  });

  it('gives loose the warm paper tint and a soft stroke', () => {
    const s = nodeStyle({ binding: 'loose', status: 'idle', lod: 2, theme: lightTheme });
    expect(s.fill).toBe(lightTheme.paper);
    expect(s.strokeStyle).toBe('soft');
  });

  it('shows a live dot on bound objects and never a port dot', () => {
    for (const lod of LODS) {
      const s = nodeStyle({ binding: 'bound', status: 'ready', lod, theme: lightTheme });
      expect(s.showLiveDot).toBe(true);
      expect(s.showPortDots).toBe(false);
      expect(s.showStatusChip).toBe(false);
    }
  });

  it('shows port dots only on wired nodes, and only once they are hittable', () => {
    expect(nodeStyle({ binding: 'wired', status: 'ready', lod: 0, theme: lightTheme }).showPortDots)
      .toBe(false);
    for (const lod of [1, 2, 3] as LOD[]) {
      expect(nodeStyle({ binding: 'wired', status: 'ready', lod, theme: lightTheme }).showPortDots)
        .toBe(true);
    }
    for (const binding of ['loose', 'bound'] as BindingState[]) {
      for (const lod of LODS) {
        expect(nodeStyle({ binding, status: 'ready', lod, theme: lightTheme }).showPortDots)
          .toBe(false);
      }
    }
  });

  it('carries a status color at every LOD, so LOD0 can draw its status dot', () => {
    const statuses: NodeStatus[] = ['idle', 'stale', 'computing', 'ready', 'error', 'unverified'];
    const seen = new Set<string>();
    for (const status of statuses) {
      const s = nodeStyle({ binding: 'wired', status, lod: 0, theme: lightTheme });
      expect(s.statusColor).toBe(statusColor(status, lightTheme));
      seen.add(s.statusColor);
    }
    // Every status is visually distinct, otherwise the dot says nothing.
    expect(seen.size).toBe(statuses.length);
  });

  it('sinks a frozen card back a step without hiding it', () => {
    const live = nodeStyle({ binding: 'loose', status: 'idle', lod: 2, theme: lightTheme });
    const frozen = nodeStyle({
      binding: 'loose',
      status: 'idle',
      lod: 2,
      theme: lightTheme,
      frozen: true,
    });
    expect(frozen.opacity).toBeLessThan(live.opacity);
    expect(frozen.opacity).toBeGreaterThan(0.5);
  });

  it('thickens the stroke on selection', () => {
    const plain = nodeStyle({ binding: 'wired', status: 'ready', lod: 2, theme: lightTheme });
    const selected = nodeStyle({
      binding: 'wired',
      status: 'ready',
      lod: 2,
      theme: lightTheme,
      selected: true,
    });
    expect(selected.strokeWidth).toBeGreaterThan(plain.strokeWidth);
  });
});
