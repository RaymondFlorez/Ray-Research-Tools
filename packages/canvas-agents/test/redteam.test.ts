import { describe, expect, it } from 'vitest';
import { CLEAN, INJECTIONS, KNOWN_LIMITS, runRedTeam } from '../src/redteam.js';

/**
 * Appendix B, phase 6: "Reconciler catches 100 percent of injected numeric
 * mismatches in the red-team suite."
 */
describe('the phase 6 exit criterion', () => {
  const report = runRedTeam();

  it('catches every injected numeric mismatch', () => {
    expect(report.missed).toEqual([]);
    expect(report.catchRate).toBe(1);
    expect(report.injections).toBe(INJECTIONS.length);
  });

  it('names each failure as the thing it actually is', () => {
    // Catching the sign flip for the wrong reason is not catching it: the
    // analyst reads the finding, and a wrong one sends them to the wrong place.
    expect(report.misattributed).toEqual([]);
  });

  // A checker that rejects every draft also scores 100 percent, so the catch
  // rate means nothing without this. Each clean variant is something a working
  // Scribe legitimately emits.
  it('passes every clean draft', () => {
    expect(report.falsePositives).toEqual([]);
    expect(report.cleanVariants).toBe(CLEAN.length);
  });

  it('keeps its known gap visible rather than out of the suite', () => {
    expect(report.knownLimits).toEqual(
      KNOWN_LIMITS.map((limit) => ({ id: limit.id, stillUncaught: true })),
    );
  });

  it('reports the numbers', () => {
    // eslint-disable-next-line no-console
    console.log(
      `red team: ${report.caught}/${report.injections} caught, ` +
        `${report.falsePositives.length}/${report.cleanVariants} false positives, ` +
        `${report.knownLimits.length} documented gap(s)`,
    );
    expect(report.falsePositiveRate).toBe(0);
  });
});
