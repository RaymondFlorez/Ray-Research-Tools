import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, modelById } from '@picasso/canvas-router';
import {
  compose,
  estimateCostCents,
  IDLE_MS,
  MAX_LINES,
  shouldDigest,
  type DigestInput,
} from '../src/digest.js';

const eightB = modelById(DEFAULT_POLICY, 'server-8b')!;

/** PRD 7.1: three anomaly halos, two theses contradicted, one stale node. */
function afternoon(): DigestInput {
  return {
    since: 1_772_000_000_000,
    now: 1_772_000_000_000 + 95 * 60 * 1000,
    moves: [
      { nodeId: 'nvda', label: 'NVDA', pct: -4.1, z: 3.4 },
      { nodeId: 'soxl', label: 'SOXL', pct: -9.6, z: 2.9 },
      { nodeId: 'spx', label: 'SPX', pct: -0.4, z: 0.6 },
    ],
    events: [
      { nodeId: 'nvda', label: 'NVDA', family: 'robust_z', severity: 3.4, at: 1_772_000_100_000 },
      { nodeId: 'soxl', label: 'SOXL', family: 'robust_z', severity: 2.9, at: 1_772_000_200_000 },
      { nodeId: 'curve', label: 'USD curve', family: 'bocpd', severity: 4.1, at: 1_772_000_300_000 },
    ],
    thesisChanges: [
      { nodeId: 'h1', claim: 'segment GM lands below 71', from: 'undetermined', to: 'contradicted' },
      { nodeId: 'h2', claim: 'the curve stays anchored through March', from: 'supported', to: 'contradicted' },
    ],
    stale: [{ nodeId: 'scn', label: 'RateShockScenario', reason: 'the curve moved past its z-threshold' }],
  };
}

describe('when a digest happens', () => {
  it('is an idle period over thirty minutes', () => {
    expect(shouldDigest(IDLE_MS)).toBe(false);
    expect(shouldDigest(IDLE_MS + 1)).toBe(true);
  });
});

describe('the card', () => {
  it('states in four lines what fired and which theses are contradicted', () => {
    const digest = compose(afternoon());
    expect(digest.lines).toHaveLength(MAX_LINES);
    expect(digest.lines[0]?.section).toBe('thesis');
    expect(digest.lines[0]?.text).toContain('2 theses');
  });

  // The walkthrough's card leads with the theses, because that is the only
  // item on it that says the analyst's own stated belief is now wrong.
  it('ranks a contradicted thesis above any price move', () => {
    const digest = compose(afternoon());
    const thesis = digest.lines.findIndex((l) => l.section === 'thesis');
    const move = digest.lines.findIndex((l) => l.section === 'move');
    expect(thesis).toBeLessThan(move);
  });

  it('cuts to four and says how many it considered', () => {
    const digest = compose(afternoon());
    expect(digest.considered).toBeGreaterThan(MAX_LINES);
  });

  it('is deterministic in shape: the same input twice gives the same card', () => {
    expect(compose(afternoon())).toEqual(compose(afternoon()));
  });

  // If the model chose what to mention, two identical mornings would produce
  // two different cards and the analyst would have to read the whole thing to
  // find out whether anything changed.
  it('lets a prose writer restate a line but never add, drop or reorder one', () => {
    const plain = compose(afternoon());
    const written = compose(afternoon(), (line) => `[${line.section}] rewritten`);
    expect(written.lines.map((l) => l.section)).toEqual(plain.lines.map((l) => l.section));
    expect(written.lines.map((l) => l.nodeIds)).toEqual(plain.lines.map((l) => l.nodeIds));
    expect(written.lines[0]?.text).toBe('[thesis] rewritten');
  });

  it('names the node behind every line so the card can fly the viewport', () => {
    for (const line of compose(afternoon()).lines) {
      expect(line.nodeIds.length).toBeGreaterThan(0);
    }
  });

  it('degrades to what there is when nothing much happened', () => {
    const quiet = compose({
      since: 0,
      now: IDLE_MS + 1,
      moves: [{ nodeId: 'spx', label: 'SPX', pct: 0.2, z: 0.3 }],
      events: [],
      thesisChanges: [],
      stale: [],
    });
    expect(quiet.lines).toHaveLength(1);
    expect(quiet.lines[0]?.text).toContain('SPX moved +0.2%');
  });
});

describe('the payload the model reads', () => {
  it('carries structured detector output and no series data', () => {
    const payload = compose(afternoon()).payload;
    expect(payload).toContain('NVDA');
    expect(JSON.parse(payload)).toHaveProperty('events');
    expect(payload.length).toBeLessThan(1500);
  });

  // PRD 7.1: "Cost of that digest: about 0.02 cents." Measured here it comes
  // out at 0.0033 cents on the policy's 8B row — an order of magnitude under
  // the PRD's figure, which is the direction to be wrong in, and the reason is
  // visible in the payload above: a few hundred characters of structured output and a
  // fixed instruction, with the series data left where it lives.
  it('costs a fraction of a cent on the 8B model', () => {
    const cost = estimateCostCents(compose(afternoon()), eightB.centsPerKiloToken);
    expect(cost).toBeLessThan(0.02);
    expect(cost).toBeCloseTo(0.0033, 4);
  });
});
