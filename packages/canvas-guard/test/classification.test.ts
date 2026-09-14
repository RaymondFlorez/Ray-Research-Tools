import { describe, expect, it } from 'vitest';
import { atLeast, combine, mustStayInTenant, rank, stamp } from '../src/classification.js';

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
