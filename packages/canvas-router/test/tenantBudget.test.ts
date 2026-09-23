import { describe, expect, it } from 'vitest';
import {
  HARD_STOP,
  InvalidOverride,
  SOFT_WARNING,
  TenantBudget,
  monthOf,
} from '../src/tenantBudget.js';

const CEILING = 100_000; // $1,000
const MARCH = Date.UTC(2026, 2, 11, 9, 0);
const APRIL = Date.UTC(2026, 3, 2, 9, 0);

function budget(over: Partial<{ ceilingCents: number; utcOffsetMinutes: number }> = {}) {
  return new TenantBudget('alphalytica', { ceilingCents: CEILING, ...over });
}

describe('the thresholds', () => {
  it('is the PRD\'s 70 percent and 100 percent', () => {
    expect(SOFT_WARNING).toBe(0.7);
    expect(HARD_STOP).toBe(1);
  });

  it('reports ok below seventy percent', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: 69_000 });
    const decision = b.check(100, MARCH);
    expect(decision.tier).toBe('ok');
    expect(decision.allowed).toBe(true);
    expect(decision.message).toBeUndefined();
  });

  it('warns at seventy percent without refusing', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: 70_000 });
    const decision = b.check(100, MARCH);
    expect(decision.tier).toBe('warning');
    expect(decision.allowed).toBe(true);
    expect(decision.message).toMatch(/70%/);
  });

  it('stops at the ceiling', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: CEILING });
    const decision = b.check(100, MARCH);
    expect(decision.tier).toBe('stopped');
    expect(decision.allowed).toBe(false);
    expect(decision.shortfallCents).toBe(100);
    expect(decision.message).toMatch(/\$1000\.00/);
  });

  it('refuses a request that would cross the ceiling, not just one that starts past it', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: 99_950 });
    // Still under, so not stopped — but this request does not fit.
    const decision = b.check(100, MARCH);
    expect(decision.tier).toBe('warning');
    expect(decision.allowed).toBe(false);
    expect(decision.shortfallCents).toBe(50);
  });

  // "Soft warning at 70 percent" reads like something that fires once. Fired
  // once, it is missed once, by whoever happened to be working at that moment.
  it('reports the tier on every decision, not once at the crossing', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: 85_000 });
    for (let i = 0; i < 5; i += 1) {
      expect(b.check(10, MARCH).tier, `call ${i}`).toBe('warning');
    }
  });
});

describe('spend belongs to the month it happened in', () => {
  // Attributing it to the month of the query makes a month's total depend on
  // when somebody asked, and the report that disagrees is always the one
  // somebody is using to argue about a bill.
  it('counts a March dispatch against March, whenever it is queried', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: 40_000 });
    expect(b.spentIn('2026-03')).toBe(40_000);
    expect(b.spentIn('2026-04')).toBe(0);

    // Queried in April, the March spend is still March's.
    expect(b.check(100, APRIL).spentCents).toBe(0);
    expect(b.check(100, APRIL).month).toBe('2026-04');
    expect(b.spentIn('2026-03')).toBe(40_000);
  });

  it('starts each month clean', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: CEILING });
    expect(b.check(100, MARCH).tier).toBe('stopped');
    expect(b.check(100, APRIL).tier).toBe('ok');
  });

  it('puts a boundary dispatch on the right side of it', () => {
    const b = budget();
    const lastMoment = Date.UTC(2026, 2, 31, 23, 59, 59, 999);
    const firstMoment = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
    b.record({ tenantId: 'alphalytica', at: lastMoment, cents: 100 });
    b.record({ tenantId: 'alphalytica', at: firstMoment, cents: 200 });
    expect(b.spentIn('2026-03')).toBe(100);
    expect(b.spentIn('2026-04')).toBe(200);
  });

  // A tenant billed in New York does not roll over at UTC midnight, and the
  // last five hours of a month are not nothing at quarter-end.
  it('respects the tenant\'s own month boundary', () => {
    const newYork = budget({ utcOffsetMinutes: -300 });
    // 2am UTC on April 1 is still 10pm on March 31 in New York.
    const at = Date.UTC(2026, 3, 1, 2, 0);
    newYork.record({ tenantId: 'alphalytica', at, cents: 500 });
    expect(newYork.spentIn('2026-03')).toBe(500);
    expect(newYork.spentIn('2026-04')).toBe(0);

    // The same instant, for a tenant on UTC, is April.
    const utc = budget();
    utc.record({ tenantId: 'alphalytica', at, cents: 500 });
    expect(utc.spentIn('2026-04')).toBe(500);
  });

  it('formats the month the way an override has to name it', () => {
    expect(monthOf(MARCH)).toBe('2026-03');
    expect(monthOf(Date.UTC(2026, 11, 25))).toBe('2026-12');
    expect(monthOf(Date.UTC(2026, 0, 1))).toBe('2026-01');
  });
});

/**
 * The part that is easiest to build in a way that quietly stops working.
 */
describe('the override path', () => {
  const OVERRIDE = {
    month: '2026-03',
    additionalCents: 50_000,
    approver: 'desk-head',
    reason: 'Q1 close, the scenario grid has to finish',
    expiresAt: Date.UTC(2026, 2, 20),
  };

  it('lifts the ceiling for the month it names', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: CEILING });
    expect(b.check(100, MARCH).allowed).toBe(false);

    b.approveOverride(OVERRIDE);
    const decision = b.check(100, MARCH);
    expect(decision.allowed).toBe(true);
    expect(decision.ceilingCents).toBe(150_000);
    // The base ceiling is still reported, so a raised ceiling is visible
    // rather than implied.
    expect(decision.baseCeilingCents).toBe(CEILING);
    expect(decision.message).toMatch(/desk-head/);
    expect(decision.message).toMatch(/Q1 close/);
  });

  // The trap. "Hard stop with an override path" invites an implementation
  // where the stop fires once, somebody approves, and the tenant is
  // effectively uncapped from then on.
  it('stops applying at its expiry', () => {
    const b = budget();
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: CEILING });
    b.approveOverride(OVERRIDE);

    expect(b.check(100, MARCH).allowed).toBe(true);
    const afterExpiry = Date.UTC(2026, 2, 21);
    expect(b.check(100, afterExpiry).allowed).toBe(false);
    expect(b.check(100, afterExpiry).ceilingCents).toBe(CEILING);
    expect(b.check(100, afterExpiry).override).toBeUndefined();
  });

  it('does not carry into the next month', () => {
    const b = budget();
    b.approveOverride({ ...OVERRIDE, expiresAt: Date.UTC(2026, 5, 1) });
    b.record({ tenantId: 'alphalytica', at: APRIL, cents: CEILING });
    // Still in force by its expiry, but it names March.
    expect(b.check(100, APRIL).ceilingCents).toBe(CEILING);
    expect(b.check(100, APRIL).allowed).toBe(false);
  });

  // Same rule as every other override in this codebase: a raise nobody is
  // accountable for, or nobody can review, is not a raise anyone should accept.
  it('refuses an override with no approver, no reason, no expiry or no amount', () => {
    const b = budget();
    expect(() => b.approveOverride({ ...OVERRIDE, approver: '  ' })).toThrow(InvalidOverride);
    expect(() => b.approveOverride({ ...OVERRIDE, reason: '' })).toThrow(InvalidOverride);
    expect(() => b.approveOverride({ ...OVERRIDE, expiresAt: Number.POSITIVE_INFINITY })).toThrow(
      InvalidOverride,
    );
    expect(() => b.approveOverride({ ...OVERRIDE, additionalCents: 0 })).toThrow(InvalidOverride);
    expect(() => b.approveOverride({ ...OVERRIDE, month: 'March' })).toThrow(InvalidOverride);
    // And none of them took effect.
    b.record({ tenantId: 'alphalytica', at: MARCH, cents: CEILING });
    expect(b.check(1, MARCH).allowed).toBe(false);
  });

  it('is visible on every decision while it is in force, not only when it bites', () => {
    const b = budget();
    b.approveOverride(OVERRIDE);
    // Nowhere near the ceiling, and the raise is still reported.
    const decision = b.check(100, MARCH);
    expect(decision.tier).toBe('ok');
    expect(decision.override?.approver).toBe('desk-head');
    expect(decision.message).toMatch(/Ceiling raised/);
  });
});
