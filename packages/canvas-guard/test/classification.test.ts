import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATIONS,
  atLeast,
  combine,
  mustStayInTenant,
  rank,
  stamp,
  type Classification,
} from '../src/classification.js';

describe('the four classes', () => {
  it('are ordered by how much damage leaving the tenant does', () => {
    expect(rank('public')).toBeLessThan(rank('licensed'));
    expect(rank('licensed')).toBeLessThan(rank('positions'));
    expect(rank('positions')).toBeLessThan(rank('mnpi_risk'));
  });

  // A prompt built from a public filing and one position line is position
  // data. There is no averaging and no majority.
  it('combine to the most sensitive class present', () => {
    expect(combine(['public', 'public', 'positions', 'licensed'])).toBe('positions');
    expect(combine([])).toBe('public');
    expect(combine(['licensed', 'mnpi_risk'])).toBe('mnpi_risk');
  });

  // Written as a floor rather than as a pair of equality checks, so a class
  // added above `positions` is bound by default instead of by remembering.
  it('bind everything at or above positions to the tenant', () => {
    expect(mustStayInTenant('public')).toBe(false);
    expect(mustStayInTenant('licensed')).toBe(false);
    expect(mustStayInTenant('positions')).toBe(true);
    expect(mustStayInTenant('mnpi_risk')).toBe(true);
    expect(atLeast('mnpi_risk', 'positions')).toBe(true);
  });

  it('stamp a record with its tenant and vendor', () => {
    expect(stamp('t1', 'licensed', 41.2, 'vendor-x')).toEqual({
      tenantId: 't1',
      classification: 'licensed',
      value: 41.2,
      vendor: 'vendor-x',
    });
  });
});

// ---------------------------------------------------------------------------
// Regressions from the security review.
// ---------------------------------------------------------------------------

describe('a classification this build does not recognize', () => {
  // The type says it cannot happen; the type is erased at the boundary where
  // the stamps arrive. `RANK[unknown]` is `undefined`, `undefined > 0` is
  // false, and so `combine` skipped the class entirely and reported `public`
  // for a payload containing nothing else. The most sensitive thing in the
  // system became the least.
  const unknown = 'restricted_client_list' as Classification;

  it('ranks at the top, not the bottom', () => {
    expect(rank(unknown)).toBe(rank('mnpi_risk'));
    expect(rank(unknown)).toBeGreaterThan(rank('public'));
  });

  it('wins the combine rather than being skipped', () => {
    expect(combine([unknown])).toBe(unknown);
    expect(combine(['public', unknown])).toBe(unknown);
    expect(combine([unknown, 'public'])).toBe(unknown);
  });

  it('is held inside the tenant boundary', () => {
    expect(mustStayInTenant(unknown)).toBe(true);
    expect(mustStayInTenant(combine(['public', 'licensed', unknown]))).toBe(true);
  });

  it('does not displace a known class it is combined with', () => {
    // `mnpi_risk` and an unknown class tie; the first one seen wins, and either
    // answer holds the payload in the tenant, which is what the caller asks.
    expect(mustStayInTenant(combine(['mnpi_risk', unknown]))).toBe(true);
    expect(mustStayInTenant(combine([unknown, 'mnpi_risk']))).toBe(true);
  });

  it('satisfies atLeast against every floor', () => {
    for (const floor of CLASSIFICATIONS) expect(atLeast(unknown, floor)).toBe(true);
  });

  it('leaves the four known classes ordered as before', () => {
    expect(CLASSIFICATIONS.map(rank)).toEqual([0, 1, 2, 3]);
    expect(combine(['public', 'licensed'])).toBe('licensed');
    expect(combine([])).toBe('public');
  });
});
