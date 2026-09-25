/**
 * The alert seam: detector firings reaching the return digest (PRD 3.6).
 *
 * `canvas-data` runs the three detector families over a series and reports
 * severity in robust standard deviations. `canvas-agents` composes the digest
 * an analyst reads on return, ranking detector lines by that severity. The two
 * packages do not depend on each other, and each declares the three family
 * names for itself — so the assignment below is the only thing that notices if
 * one of them grows a fourth family, and it notices at typecheck.
 */

import { describe, expect, it } from 'vitest';
import {
  bocpdFirings,
  robustZFirings,
  stlFirings,
  type Firing,
} from '@picasso/canvas-data';
import { compose, type DetectorEvent, type DetectorFamily } from '@picasso/canvas-agents';

function uniform(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(n: number, seed: number): number[] {
  const r = uniform(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = r() || 1e-12;
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
  }
  return out;
}

const HOUR = 3_600_000;
const START = Date.UTC(2026, 2, 1);

/** A firing on a node, as the digest wants it. */
function event(nodeId: string, label: string, firing: Firing): DetectorEvent {
  // The seam, checked by the compiler: canvas-data's family is canvas-agents'.
  const family: DetectorFamily = firing.family;
  return { nodeId, label, family, severity: firing.severity, at: START + firing.index * HOUR };
}

describe('three watched series, three detectors, one digest', () => {
  // Rates: the level stepped up four sd and stayed.
  const rates = normals(720, 3).map((x, i) => 4.2 + 0.02 * x + (i >= 600 ? 0.08 : 0));
  // FX: one print far off the tape.
  const fx = normals(720, 5).map((x, i) => 1.08 + 0.001 * x + (i === 650 ? 0.012 : 0));
  // Power: a daily cycle, and one overnight hour at the daytime level.
  const power = normals(720, 4).map((e, i) => 50 + 3 * Math.sin((2 * Math.PI * i) / 24) + 0.2 * e);
  const trough = 18 + 24 * 27;
  power[trough] = power[trough - 12]!;

  const firings = {
    rates: bocpdFirings(rates),
    fx: robustZFirings(fx),
    power: stlFirings(power, { period: 24 }),
  };

  it('each detector catches the thing only it was built for', () => {
    expect(firings.rates.some((f) => f.index >= 600 && f.index <= 605)).toBe(true);
    expect(firings.fx.some((f) => f.index === 650)).toBe(true);
    expect(firings.power.some((f) => f.index === trough)).toBe(true);
    // And the robust z is silent on the overnight print, which is inside the
    // series' daily range.
    expect(robustZFirings(power).some((f) => f.index === trough)).toBe(false);
  });

  it('reaches the digest ranked by severity, across families', () => {
    const since = START + 590 * HOUR;
    const events = [
      ...firings.rates.filter((f) => f.index >= 590).map((f) => event('rates', 'UST 10y', f)),
      ...firings.fx.filter((f) => f.index >= 590).map((f) => event('fx', 'EURUSD', f)),
      ...firings.power.filter((f) => f.index >= 590).map((f) => event('power', 'ERCOT hub', f)),
    ];
    const digest = compose({
      since,
      now: START + 720 * HOUR,
      moves: [],
      events,
      thesisChanges: [],
      stale: [],
    });
    const detectorLines = digest.lines.filter((l) => l.section === 'detector');
    expect(detectorLines).toHaveLength(3);
    // Severity is in robust sd for every family, so the order is by size of
    // surprise rather than by which detector shouts loudest.
    const leads = detectorLines.map((l) => Number(/severity (\d+\.\d)/.exec(l.text)![1]));
    expect(leads).toEqual([...leads].sort((a, b) => b - a));
    expect(detectorLines.map((l) => l.nodeIds[0])).toContain('power');
  });
});
