import { describe, expect, it } from 'vitest';
import {
  CrossTenantAccess,
  MissingTenantPredicate,
  TenantQuery,
  TenantScoped,
  assertSameTenant,
} from '../src/tenant.js';

interface Row {
  tenantId: string;
  id: string;
  shares: number;
}

const rows: Row[] = [
  { tenantId: 'a', id: 'a1', shares: 12_450 },
  { tenantId: 'a', id: 'a2', shares: 100 },
  { tenantId: 'b', id: 'b1', shares: 9_999 },
];

describe('the query cannot forget its predicate', () => {
  it('has no constructor without a tenant', () => {
    expect(() => new TenantQuery<Row>('positions', '')).toThrow(MissingTenantPredicate);
  });

  it('applies the tenant separately from and before the caller predicates', () => {
    const all = new TenantQuery<Row>('positions', 'a').where(() => true).run(rows);
    expect(all.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  // A predicate written to name another tenant returns nothing rather than
  // that tenant's rows: the two filters are conjunctive, not alternative.
  it('cannot be widened by a predicate that names another tenant', () => {
    const found = new TenantQuery<Row>('positions', 'a').where((r) => r.tenantId === 'b').run(rows);
    expect(found).toEqual([]);
  });

  it('still filters normally within the tenant', () => {
    const found = new TenantQuery<Row>('positions', 'a').where((r) => r.shares > 1000).run(rows);
    expect(found.map((r) => r.id)).toEqual(['a1']);
  });
});

describe('per-tenant collections', () => {
  // "A filter bug in a shared index is a cross-tenant data leak." A separate
  // collection has no filter to get wrong.
  it('give a handle no path to another tenant', () => {
    const store = new TenantScoped<string>();
    store.collection('b').put('doc-1', 'B secret');
    const a = store.collection('a');
    expect(a.get('doc-1')).toBeUndefined();
    expect(a.ids()).toEqual([]);
    expect(a.size()).toBe(0);
  });

  it('keep each tenant\'s writes to itself', () => {
    const store = new TenantScoped<string>();
    store.collection('a').put('doc-1', 'A');
    store.collection('b').put('doc-1', 'B');
    expect(store.collection('a').get('doc-1')).toBe('A');
    expect(store.collection('b').get('doc-1')).toBe('B');
    expect(store.tenantCount()).toBe(2);
  });

  it('refuse a collection with no tenant', () => {
    expect(() => new TenantScoped<string>().collection('  ')).toThrow(MissingTenantPredicate);
  });
});

describe('an artifact handed across a boundary', () => {
  // Throws rather than returning false: every call site that could reasonably
  // continue would be continuing with somebody else's data in hand.
  it('throws rather than returning a decision the caller might ignore', () => {
    expect(() => assertSameTenant('a', { tenantId: 'b', id: 'canvas-7' })).toThrow(CrossTenantAccess);
    expect(() => assertSameTenant('a', { tenantId: 'a', id: 'canvas-7' })).not.toThrow();
  });

  it('names the resource in the error', () => {
    try {
      assertSameTenant('a', { tenantId: 'b', id: 'canvas-7' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('canvas-7');
    }
  });
});
