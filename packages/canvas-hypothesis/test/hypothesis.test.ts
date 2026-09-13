import { describe, expect, it } from 'vitest';
import {
  resolve,
  validate,
  type Hypothesis,
  type Observable,
  type Observation,
} from '../src/hypothesis.js';

/**
 * PRD 7.4, verbatim: "NVDA data center gross margin compresses below 71 percent
 * by the Q2 report." Observable: reported segment GM. Threshold: 71 percent.
 * Date: the next report. Falsifier: GM above 73 percent.
 */
const nvda: Hypothesis = {
  id: 'h1',
  claim: 'NVDA data center gross margin compresses below 71% by the Q2 report',
  confidence: 0.65,
  createdAt: '2026-02-10',
  observables: [
    {
      id: 'dc-gm',
      name: 'data center segment gross margin',
      direction: 'below',
      threshold: 71,
      falsifier: 73,
      dueBy: '2026-08-20',
      unit: '%',
    },
  ],
};

const seen = (value: number, observedAt = '2026-08-18'): Observation[] => [
  { observableId: 'dc-gm', value, observedAt, source: 'Q2 10-Q' },
];

/** The first observable, which every fixture here has. */
function first(h: Hypothesis): Observable {
  const observable = h.observables[0];
  if (!observable) throw new Error('fixture has no observable');
  return observable;
}

describe('the worked example', () => {
  it('is supported when the margin compresses past the threshold', () => {
    const result = resolve(nvda, seen(70.2), '2026-08-21');
    expect(result.status).toBe('supported');
    expect(result.outcome).toBe(true);
    expect(result.resolvedAt).toBe('2026-08-18');
    expect(result.explanation).toContain('70.2% is below the 71% threshold');
  });

  it('is contradicted when the margin passes the falsifier', () => {
    const result = resolve(nvda, seen(74.1), '2026-08-21');
    expect(result.status).toBe('contradicted');
    expect(result.outcome).toBe(false);
    expect(result.explanation).toContain('passed the 73% falsifier');
  });

  /**
   * The dead zone, which is the whole reason there are two numbers.
   *
   * Gross margin at 72 does not confirm "below 71" and does not refute it. A
   * tracker with one cutoff would have to call this a win or a loss, and the
   * analyst's record would be measuring the tracker's arbitrariness.
   */
  it('is neither right nor wrong between the threshold and the falsifier', () => {
    const result = resolve(nvda, seen(72), '2026-08-21');
    expect(result.status).toBe('undetermined');
    // No outcome at all, so nothing reaches the calibration record.
    expect(result.outcome).toBeUndefined();
    expect(result.explanation).toContain('neither confirmed nor refuted');
  });

  it('is open until the date, and expired after it', () => {
    expect(resolve(nvda, [], '2026-06-01').status).toBe('undetermined');
    expect(resolve(nvda, [], '2026-06-01').explanation).toContain('awaiting');

    const lapsed = resolve(nvda, [], '2026-09-01');
    expect(lapsed.status).toBe('expired');
    expect(lapsed.outcome).toBeUndefined();
    expect(lapsed.explanation).toContain('nothing was observed');
  });

  it('resolves itself without being told to', () => {
    // "The node will resolve itself when the data arrives, whether or not she
    // remembers it." Same inputs, same answer, no state in between.
    const once = resolve(nvda, seen(70.2), '2026-08-21');
    const twice = resolve(nvda, seen(70.2), '2026-08-21');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe('a claim that cannot be wrong is not a claim', () => {
  it('rejects a falsifier on the wrong side of the threshold', () => {
    const unfalsifiable: Hypothesis = {
      ...nvda,
      observables: [{ ...first(nvda), falsifier: 69 }],
    };
    const problems = validate(unfalsifiable);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('far side of the threshold');
  });

  it('rejects a claim with nothing to observe', () => {
    expect(validate({ ...nvda, observables: [] })[0]).toContain('only believed');
  });

  it('rejects a confidence that is not a probability', () => {
    expect(validate({ ...nvda, confidence: 65 })[0]).toContain('between 0 and 1');
  });

  it('accepts the worked example', () => {
    expect(validate(nvda)).toEqual([]);
  });
});

describe('several observables', () => {
  const compound: Hypothesis = {
    ...nvda,
    observables: [
      first(nvda),
      {
        id: 'revenue',
        name: 'data center revenue',
        direction: 'above',
        threshold: 40,
        falsifier: 34,
        dueBy: '2026-08-20',
        unit: 'bn',
      },
    ],
  };

  it('needs all of them to be supported', () => {
    const result = resolve(
      compound,
      [...seen(70.2), { observableId: 'revenue', value: 41, observedAt: '2026-08-18' }],
      '2026-08-21',
    );
    expect(result.status).toBe('supported');
  });

  /** A falsifier that fires wins, whatever else held. */
  it('is refuted if any falsifier fires, however well the rest went', () => {
    const result = resolve(
      compound,
      [...seen(70.2), { observableId: 'revenue', value: 33, observedAt: '2026-08-18' }],
      '2026-08-21',
    );
    expect(result.status).toBe('contradicted');
    expect(result.explanation).toContain('data center revenue');
    // The supported half is still on the record, so the analyst can see the split.
    expect(result.outcomes.filter((o) => o.status === 'supported')).toHaveLength(1);
  });

  it('stays open while one observation is still awaited', () => {
    const result = resolve(compound, seen(70.2), '2026-06-01');
    expect(result.status).toBe('undetermined');
  });
});

describe('a record cannot be edited after the fact', () => {
  it('takes the first observation, not a later revision', () => {
    // The Q2 print said 70.2 and a restatement later said 74. The claim was
    // resolved by the data available on the day; a tracker that let a
    // restatement flip a settled call would not be a track record.
    const result = resolve(
      nvda,
      [
        { observableId: 'dc-gm', value: 74, observedAt: '2026-11-02', source: 'restated' },
        { observableId: 'dc-gm', value: 70.2, observedAt: '2026-08-18', source: 'Q2 10-Q' },
      ],
      '2026-12-01',
    );
    expect(result.status).toBe('supported');
    expect(result.resolvedAt).toBe('2026-08-18');
  });
});
