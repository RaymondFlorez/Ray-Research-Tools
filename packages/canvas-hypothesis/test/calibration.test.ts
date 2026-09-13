import { describe, expect, it } from 'vitest';
import { calibrate, MIN_SCORED, trackRecord, type Scored } from '../src/calibration.js';

/** `n` predictions at `confidence`, of which `hits` came true. */
function batch(confidence: number, n: number, hits: number): Scored[] {
  return Array.from({ length: n }, (_, i) => ({ confidence, outcome: i < hits }));
}

describe('the Brier score', () => {
  it('is zero for a forecaster who is always certain and always right', () => {
    const perfect = [...batch(1, 10, 10), ...batch(0, 10, 0)];
    expect(calibrate(perfect).brier).toBeCloseTo(0, 12);
  });

  it('is a quarter for someone who always says fifty-fifty', () => {
    expect(calibrate(batch(0.5, 20, 10)).brier).toBeCloseTo(0.25, 12);
  });

  it('is one for a forecaster who is always certain and always wrong', () => {
    expect(calibrate([...batch(1, 10, 0), ...batch(0, 10, 10)]).brier).toBeCloseTo(1, 12);
  });

  /**
   * Murphy's identity: `brier = reliability − resolution + uncertainty`.
   *
   * The three parts are computed from bucket statistics and the score from the
   * raw predictions, so the identity only holds if both are right. It is the
   * self-check on the whole file.
   */
  it('decomposes exactly, on every record thrown at it', () => {
    const records: Scored[][] = [
      [...batch(0.9, 20, 17), ...batch(0.6, 30, 18), ...batch(0.2, 25, 6)],
      [...batch(0.8, 15, 4), ...batch(0.35, 40, 21)],
      [...batch(0.95, 12, 12), ...batch(0.05, 18, 1), ...batch(0.5, 11, 5)],
      batch(0.7, 40, 28),
    ];
    for (const record of records) {
      const c = calibrate(record);
      expect(c.reliability - c.resolution + c.uncertainty).toBeCloseTo(c.brier, 12);
    }
  });

  it('separates being well calibrated from knowing anything', () => {
    // Always states the base rate, and the base rate is right. Perfectly
    // calibrated, and completely uninformative — reliability at zero and
    // resolution at zero too.
    const uninformative = batch(0.5, 40, 20);
    const flat = calibrate(uninformative);
    expect(flat.reliability).toBeCloseTo(0, 12);
    expect(flat.resolution).toBeCloseTo(0, 12);

    // Same base rate, but the confident calls come true and the doubtful ones
    // do not. Same reliability, far more resolution — and a better score.
    const informative = [...batch(0.9, 20, 18), ...batch(0.1, 20, 2)];
    const sharp = calibrate(informative);
    expect(sharp.resolution).toBeGreaterThan(0.1);
    expect(sharp.brier).toBeLessThan(flat.brier);
  });

  it('measures which way the analyst leans', () => {
    const overconfident = calibrate(batch(0.9, 40, 24));
    expect(overconfident.overconfidence).toBeCloseTo(0.9 - 0.6, 12);

    const underconfident = calibrate(batch(0.4, 40, 32));
    expect(underconfident.overconfidence).toBeLessThan(0);
  });
});

describe('the reliability diagram', () => {
  it('buckets by stated confidence and reports what actually happened', () => {
    const c = calibrate([...batch(0.95, 20, 19), ...batch(0.2, 20, 5)]);
    expect(c.buckets).toHaveLength(2);
    const [low, high] = c.buckets;
    expect(low?.meanConfidence).toBeCloseTo(0.2, 12);
    expect(low?.observedRate).toBeCloseTo(0.25, 12);
    expect(high?.meanConfidence).toBeCloseTo(0.95, 12);
    expect(high?.observedRate).toBeCloseTo(0.95, 12);
  });

  it('leaves out buckets nobody predicted into', () => {
    const c = calibrate(batch(0.8, 15, 12));
    expect(c.buckets).toHaveLength(1);
    expect(c.buckets[0]?.count).toBe(15);
  });
});

describe('the line the tracker exists for', () => {
  /**
   * PRD 7.4: "Maya's own hypothesis tracker is cited: she has made this call
   * three times, right once." The next line of the PRD says that sentence is
   * why the tracker exists, so it has to be sayable.
   */
  it('says it', () => {
    expect(trackRecord(batch(0.7, 3, 1))).toBe('made this call 3 times, right once');
    expect(trackRecord(batch(0.7, 3, 1), 'the margin-compression call')).toBe(
      'made the margin-compression call 3 times, right once',
    );
    expect(trackRecord(batch(0.7, 5, 0))).toBe('made this call 5 times, never right');
    expect(trackRecord(batch(0.7, 1, 1))).toBe('made this call once, right once');
    expect(trackRecord([])).toContain('no resolved record');
  });

  /**
   * And the constraint that sentence implies: three observations is a fact, not
   * a measurement. The Brier score on it moves by 0.08 on a single outcome, so
   * reporting it would dress a coin flip up as an assessment.
   */
  it('withholds the score until there is enough history to mean anything', () => {
    const thin = calibrate(batch(0.7, 3, 1));
    expect(thin.count).toBe(3);
    expect(thin.warning).toContain('3 resolved predictions');
    expect(thin.warning).toContain('1 right');
    expect(thin.warning).toContain('not yet a calibration');

    // The numbers are still computed — a caller that wants them can have them —
    // but nothing can read one without also reading the warning.
    expect(Number.isFinite(thin.brier)).toBe(true);

    const enough = calibrate(batch(0.7, MIN_SCORED, 7));
    expect(enough.warning).toBeUndefined();
  });

  it('says so plainly when there is no record at all', () => {
    const empty = calibrate([]);
    expect(empty.count).toBe(0);
    expect(empty.warning).toContain('nothing to calibrate');
    expect(Number.isNaN(empty.brier)).toBe(true);
  });
});
