import { describe, expect, it } from 'vitest';
import { calibrate, MIN_SCORED } from '../src/calibration.js';
import { resolve, type Hypothesis, type Observation } from '../src/hypothesis.js';
import { HypothesisLedger, LedgerRefused, type LedgerEvent } from '../src/ledger.js';

/** PRD 7.4's worked example, as the other suites use it. */
const nvda = (id = 'h1', author = 'maya'): Hypothesis => ({
  id,
  claim: 'NVDA data center gross margin compresses below 71% by the Q2 report',
  confidence: 0.65,
  createdAt: '2026-02-10',
  author,
  observables: [
    { id: 'dc-gm', name: 'data center segment gross margin', direction: 'below', threshold: 71, falsifier: 73, dueBy: '2026-08-20', unit: '%' },
  ],
});

const gm = (value: number, observedAt = '2026-08-18', source = 'Q2 10-Q'): Observation => ({
  observableId: 'dc-gm',
  value,
  observedAt,
  source,
});

describe('the claim settles when its data arrives', () => {
  it('re-resolves on the observation and reports the change', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    expect(ledger.entry('h1', '2026-03-01')!.resolution.status).toBe('undetermined');
    const changed = ledger.observe(gm(70.2), '2026-08-18T21:00');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ hypothesisId: 'h1', from: 'undetermined', to: 'supported' });
    expect(ledger.scored()).toEqual([{ confidence: 0.65, outcome: true, id: 'h1', resolvedAt: '2026-08-18' }]);
    // Nothing further to report: a settled claim stays settled.
    expect(ledger.tick('2026-12-31')).toEqual([]);
  });

  it('reaches every claim wired to the same observable', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda('bear', 'maya'), '2026-02-10');
    ledger.state(
      {
        ...nvda('bull', 'sam'),
        claim: 'margin holds above 73%',
        observables: [{ ...nvda().observables[0]!, direction: 'above', threshold: 73, falsifier: 71 }],
      },
      '2026-02-11',
    );
    const changed = ledger.observe(gm(70.2), '2026-08-18');
    expect(changed.map((t) => [t.hypothesisId, t.to])).toEqual([
      ['bear', 'supported'],
      ['bull', 'contradicted'],
    ]);
    expect(ledger.scored({ author: 'sam' })).toMatchObject([{ id: 'bull', outcome: false }]);
  });

  it('expires a claim whose data never came, once, on the tick after its due date', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    expect(ledger.tick('2026-08-20')).toEqual([]);
    expect(ledger.tick('2026-08-21').map((t) => t.to)).toEqual(['expired']);
    expect(ledger.tick('2026-09-01')).toEqual([]);
    // Expired is not scored: the world not producing data is not the analyst's miss.
    expect(ledger.scored()).toEqual([]);
  });

  it('lets a number received late but dated in time resolve a claim it had reported expired', () => {
    // Ingest lag: the print was on the 18th and reached the ledger on the 25th.
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    expect(ledger.tick('2026-08-21').map((t) => t.to)).toEqual(['expired']);
    expect(ledger.observe(gm(70.2), '2026-08-25')).toMatchObject([{ from: 'expired', to: 'supported' }]);
  });

  it('reports an expiry on whatever event comes next, not only on a tick', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    ledger.state({ ...nvda('h2'), observables: [{ ...nvda().observables[0]!, id: 'rev', name: 'revenue', dueBy: '2026-12-01' }] }, '2026-02-10');
    const changed = ledger.observe({ observableId: 'rev', value: 30, observedAt: '2026-09-01' }, '2026-09-01');
    expect(changed.find((t) => t.hypothesisId === 'h1')?.to).toBe('expired');
  });
});

describe('the record cannot be edited after the fact', () => {
  it('counts the first number received, not a restatement or a backdated backfill', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    ledger.observe(gm(70.2), '2026-08-18');
    // A correction inside the window, and a number backdated before the print.
    expect(ledger.observe(gm(74, '2026-08-19', 'corrected'), '2026-08-19')).toEqual([]);
    expect(ledger.observe(gm(74, '2026-08-10', 'backfill'), '2026-08-22')).toEqual([]);
    const entry = ledger.entry('h1', '2026-09-01')!;
    expect(entry.resolution.status).toBe('supported');
    expect(entry.counted).toEqual([{ observation: gm(70.2), recordedAt: '2026-08-18' }]);
    // Both are still in the log: refused from the score, not from the record.
    expect(ledger.events().filter((e) => e.kind === 'observed')).toHaveLength(3);
  });

  it('does not let a number known before the claim settle it', () => {
    const ledger = new HypothesisLedger();
    ledger.observe(gm(70.2, '2026-08-18'), '2026-08-18');
    ledger.state(nvda(), '2026-08-19');
    expect(ledger.entry('h1', '2026-08-19T12:00')!.resolution.status).toBe('undetermined');
    expect(ledger.tick('2026-08-21').map((t) => t.to)).toEqual(['expired']);
  });

  it('dates the claim itself, whatever date the caller supplies', () => {
    const ledger = new HypothesisLedger();
    ledger.observe(gm(70.2), '2026-08-18');
    // Written after the print, backdated to February.
    const stored = ledger.state(nvda(), '2026-08-19');
    expect(stored.createdAt).toBe('2026-08-19');
    expect(ledger.scored()).toEqual([]);
  });

  it('refuses a clock that runs backwards, and a refused event changes nothing', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    ledger.tick('2026-05-01');
    expect(() => ledger.observe(gm(70.2, '2026-04-01'), '2026-04-01')).toThrow(/does not run backwards/);
    expect(() => ledger.state(nvda('h2'), '2026-03-01')).toThrow(LedgerRefused);
    expect(ledger.events()).toHaveLength(1);
    // A refused claim does not move the clock either.
    expect(() => ledger.state(nvda('h1'), '2026-06-01')).toThrow(/already on the record/);
    expect(() => ledger.state(nvda('h3'), '2026-05-15')).not.toThrow();
  });

  it('refuses a number dated after it was received, and one that is not a number', () => {
    const ledger = new HypothesisLedger();
    expect(() => ledger.observe(gm(70.2, '2026-08-18'), '2026-08-17')).toThrow(/cannot have been received/);
    expect(() => ledger.observe(gm(Number.NaN), '2026-08-18')).toThrow(/finite/);
  });

  it('refuses a claim that cannot be wrong, or one already due', () => {
    const ledger = new HypothesisLedger();
    const flat = { ...nvda(), observables: [{ ...nvda().observables[0]!, falsifier: 70 }] };
    expect(() => ledger.state(flat, '2026-02-10')).toThrow(/far side of the threshold/);
    expect(() => ledger.state(nvda(), '2026-08-20')).toThrow(/not after the claim was made/);
  });

  it('hands out copies and has no way to change what it holds', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    ledger.observe(gm(70.2), '2026-08-18');
    const events = ledger.events();
    (events[0] as Extract<LedgerEvent, { kind: 'stated' }>).hypothesis.confidence = 0.99;
    ledger.entry('h1', '2026-09-01')!.hypothesis.observables[0]!.threshold = 80;
    ledger.entries('2026-09-01', { matching: (h) => ((h.confidence = 0.01), true) });
    expect(ledger.scored()[0]!.confidence).toBe(0.65);
    expect(ledger.entry('h1', '2026-09-01')!.hypothesis.observables[0]!.threshold).toBe(71);
    const methods = Object.getOwnPropertyNames(HypothesisLedger.prototype);
    for (const verb of ['delete', 'remove', 'clear', 'truncate', 'edit', 'update', 'set']) {
      expect(methods.filter((m) => m.toLowerCase().startsWith(verb))).toEqual([]);
    }
  });
});

describe('withdrawal', () => {
  it('is allowed before any data, needs a reason, and stays on the record', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda('a'), '2026-02-10');
    ledger.state(nvda('b'), '2026-02-10');
    ledger.state(nvda('c'), '2026-02-10');
    expect(() => ledger.withdraw('a', '  ', '2026-03-01')).toThrow(/reason/);
    ledger.withdraw('a', 'the segment was reorganised; the observable no longer exists', '2026-03-01');
    expect(() => ledger.withdraw('a', 'again', '2026-03-02')).toThrow(/already withdrawn/);
    // Data arriving later reaches the others and not the withdrawn one.
    const changed = ledger.observe(gm(74.5), '2026-08-18');
    expect(changed.map((t) => t.hypothesisId)).toEqual(['b', 'c']);
    expect(() => ledger.withdraw('b', 'changed my mind', '2026-08-19')).toThrow(/has data against it/);
    expect(ledger.entry('a', '2026-09-01')).toMatchObject({ withdrawn: { at: '2026-03-01' }, counted: [] });
    expect(ledger.tally('2026-09-01')).toEqual({
      stated: 3, open: 0, supported: 0, contradicted: 2, inconclusive: 0, expired: 0, withdrawn: 1,
    });
  });

  it('is refused once the claim has expired', () => {
    const ledger = new HypothesisLedger();
    ledger.state(nvda(), '2026-02-10');
    expect(() => ledger.withdraw('h1', 'quietly', '2026-09-01')).toThrow(/expired claim stays on the record/);
  });
});

describe('the calibration history', () => {
  it('says what the score leaves out', () => {
    // "She has made this call three times, right once" — and the two calls
    // that never resolved are named after it rather than left out.
    const ledger = new HypothesisLedger();
    for (const id of ['a', 'b', 'c', 'd', 'e']) ledger.state({ ...nvda(id), observables: [{ ...nvda().observables[0]!, id: `gm-${id}` }] }, '2026-02-10');
    ledger.withdraw('e', 'duplicate of d', '2026-02-11');
    ledger.observe({ observableId: 'gm-a', value: 70, observedAt: '2026-08-18' }, '2026-08-18');
    ledger.observe({ observableId: 'gm-b', value: 75, observedAt: '2026-08-18' }, '2026-08-18');
    ledger.observe({ observableId: 'gm-c', value: 74, observedAt: '2026-08-18' }, '2026-08-18');
    expect(ledger.record('this call', '2026-09-01')).toBe(
      'made this call 3 times, right once (1 expired unchecked, 1 withdrawn before the data)',
    );
    // In the gap between threshold and falsifier: inconclusive, not open.
    ledger.state({ ...nvda('f'), observables: [{ ...nvda().observables[0]!, id: 'gm-f', dueBy: '2026-11-20' }] }, '2026-09-02');
    ledger.observe({ observableId: 'gm-f', value: 72, observedAt: '2026-11-18' }, '2026-11-18');
    expect(ledger.tally('2026-12-01')).toMatchObject({ inconclusive: 1, open: 0 });
  });

  it('feeds calibration, filtered to an analyst and a shape', () => {
    const ledger = new HypothesisLedger();
    let state = 99;
    const uniform = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0), state / 4294967296);
    for (let i = 0; i < 30; i += 1) {
      const id = `h${i}`;
      ledger.state(
        {
          ...nvda(id, i % 3 === 0 ? 'sam' : 'maya'),
          confidence: 0.5 + 0.4 * uniform(),
          claim: i % 2 === 0 ? 'margin compresses' : 'revenue beats',
          observables: [{ ...nvda().observables[0]!, id: `o${i}` }],
        },
        '2026-02-10',
      );
    }
    for (let i = 0; i < 30; i += 1) {
      ledger.observe({ observableId: `o${i}`, value: uniform() < 0.6 ? 70 : 74, observedAt: '2026-08-18' }, '2026-08-18');
    }
    const maya = ledger.scored({ author: 'maya' });
    expect(maya).toHaveLength(20);
    const margins = ledger.scored({ author: 'maya', matching: (h) => h.claim.startsWith('margin') });
    expect(margins.length).toBeGreaterThan(0);
    expect(margins.length).toBeLessThan(maya.length);
    expect(maya.length).toBeGreaterThanOrEqual(MIN_SCORED);
    expect(calibrate(maya).warning).toBeUndefined();
  });
});

describe('persistence is the log', () => {
  /** A random but valid history: claims on a few shared observables, data, ticks and withdrawals. */
  function history(seed: number): { ledger: HypothesisLedger; now: string } {
    let state = seed;
    const uniform = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0), state / 4294967296);
    const day = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    const ledger = new HypothesisLedger();
    let claims = 0;
    for (let d = 0; d < 300; d += 1) {
      const r = uniform();
      if (r < 0.15) {
        const k = Math.floor(uniform() * 4);
        const below = uniform() < 0.5;
        ledger.state(
          {
            id: `c${claims++}`,
            claim: `obs ${k}`,
            confidence: uniform(),
            createdAt: day(d),
            author: uniform() < 0.5 ? 'maya' : 'sam',
            observables: [
              {
                id: `o${k}`,
                name: `observable ${k}`,
                direction: below ? 'below' : 'above',
                threshold: below ? 50 : 52,
                falsifier: below ? 52 : 50,
                dueBy: day(d + 10 + Math.floor(uniform() * 60)),
              },
            ],
          },
          day(d),
        );
      } else if (r < 0.3) {
        // Sometimes dated a few days before it is received.
        const lag = Math.floor(uniform() * 5);
        ledger.observe({ observableId: `o${Math.floor(uniform() * 4)}`, value: 46 + uniform() * 10, observedAt: day(Math.max(0, d - lag)) }, day(d));
      } else if (r < 0.33 && claims > 0) {
        try {
          ledger.withdraw(`c${Math.floor(uniform() * claims)}`, 'test', day(d));
        } catch (e) {
          if (!(e instanceof LedgerRefused)) throw e;
        }
      } else if (r < 0.4) {
        ledger.tick(day(d));
      }
    }
    return { ledger, now: day(300) };
  }

  it('replays to the same claims, statuses, scores and tally, through JSON', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { ledger, now } = history(seed);
      const replayed = HypothesisLedger.replay(JSON.parse(JSON.stringify(ledger.events())) as LedgerEvent[]);
      expect(replayed.entries(now)).toEqual(ledger.entries(now));
      expect(replayed.scored()).toEqual(ledger.scored());
      expect(replayed.tally(now)).toEqual(ledger.tally(now));
      expect(replayed.events()).toEqual(ledger.events());
    }
  });

  it('agrees with a from-scratch reading of the log', () => {
    // Independent of the ledger's bookkeeping: walk the log, keep the first
    // in-window number received per claim and observable, and resolve.
    for (const seed of [11, 12, 13]) {
      const { ledger, now } = history(seed);
      const events = ledger.events();
      const stated = events.filter((e): e is Extract<LedgerEvent, { kind: 'stated' }> => e.kind === 'stated');
      const withdrawn = new Map(
        events.filter((e): e is Extract<LedgerEvent, { kind: 'withdrawn' }> => e.kind === 'withdrawn').map((e) => [e.hypothesisId, e.at]),
      );
      let checked = 0;
      for (const { hypothesis: h, seq } of stated) {
        const due = h.observables[0]!.dueBy;
        const first = events.find(
          (e) =>
            e.seq > seq &&
            e.kind === 'observed' &&
            e.observation.observableId === h.observables[0]!.id &&
            e.observation.observedAt > h.createdAt &&
            e.observation.observedAt <= due &&
            !(withdrawn.has(h.id) && e.at >= withdrawn.get(h.id)!),
        );
        const counted = first && first.kind === 'observed' ? [first.observation] : [];
        const expected = resolve(h, counted, withdrawn.get(h.id) ?? now);
        expect(ledger.entry(h.id, now)!.resolution.status).toBe(expected.status);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(20);
      // Every status occurs somewhere, or the check is weaker than it looks.
      const statuses = new Set(ledger.entries(now).map((e) => e.resolution.status));
      expect([...statuses].sort()).toEqual(['contradicted', 'expired', 'supported', 'undetermined']);
    }
  });

  it('refuses a log with a gap, or one a live ledger would have refused', () => {
    const { ledger } = history(7);
    const events = ledger.events();
    expect(() => HypothesisLedger.replay(events.filter((_, i) => i !== 3))).toThrow(/gap or is out of order/);
    // Edits that keep the numbering intact are still caught by the rules: a
    // number redated past its receipt, and a claim backdated before the data.
    const firstObs = events.findIndex((e) => e.kind === 'observed');
    const edited = events.map((e, i) =>
      i === firstObs && e.kind === 'observed' ? { ...e, observation: { ...e.observation, observedAt: '2027-01-01' } } : e,
    );
    expect(() => HypothesisLedger.replay(edited)).toThrow(/cannot have been received/);
    const laterClaim = events.findIndex((e, i) => i > firstObs && e.kind === 'stated');
    const backdated = events.map((e, i) => (i === laterClaim ? { ...e, at: '2025-01-01' } : e));
    expect(() => HypothesisLedger.replay(backdated)).toThrow(/does not run backwards/);
  });
});
