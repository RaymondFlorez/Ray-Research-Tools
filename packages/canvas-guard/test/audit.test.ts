import { describe, expect, it } from 'vitest';
import { AuditLog, IncompleteAuditRecord } from '../src/audit.js';

function log(): AuditLog {
  const audit = new AuditLog();
  audit.write({
    at: 1,
    tenantId: 'a',
    actor: 'maya',
    action: 'position.read',
    resource: 'portfolio/main',
    purpose: 'stress test against a 50bp shock',
    traceId: 't-1',
  });
  audit.write({
    at: 2,
    tenantId: 'a',
    actor: 'maya',
    action: 'export.create',
    resource: 'canvas/post-q4',
    purpose: 'share with partner',
  });
  return audit;
}

describe('the audit log', () => {
  // "No delete path" is a property of an interface, not a policy document.
  it('exposes no way to remove a record', () => {
    const audit = log() as unknown as Record<string, unknown>;
    for (const name of ['delete', 'remove', 'clear', 'truncate', 'pop', 'splice', 'reset']) {
      expect(audit[name]).toBeUndefined();
    }
  });

  it('hands out copies, so a holder cannot edit history through them', () => {
    const audit = log();
    const records = audit.records();
    records[0]!.purpose = 'rewritten';
    records.length = 0;
    expect(audit.records()[0]?.purpose).toBe('stress test against a 50bp shock');
    expect(audit.count()).toBe(2);
  });

  // A record that says who read what and when, but not why, answers the easy
  // half of every question anyone asks of it.
  it('refuses a record with no purpose', () => {
    expect(() =>
      new AuditLog().write({
        at: 1,
        tenantId: 'a',
        actor: 'maya',
        action: 'position.read',
        resource: 'portfolio/main',
        purpose: '  ',
      }),
    ).toThrow(IncompleteAuditRecord);
  });

  it('refuses a record with no actor, resource or tenant', () => {
    const base = {
      at: 1,
      tenantId: 'a',
      actor: 'maya',
      action: 'position.read' as const,
      resource: 'r',
      purpose: 'p',
    };
    expect(() => new AuditLog().write({ ...base, actor: '' })).toThrow(IncompleteAuditRecord);
    expect(() => new AuditLog().write({ ...base, resource: '' })).toThrow(IncompleteAuditRecord);
    expect(() => new AuditLog().write({ ...base, tenantId: '' })).toThrow(IncompleteAuditRecord);
  });

  it('numbers records in order and scopes reads by tenant', () => {
    const audit = log();
    audit.write({
      at: 3,
      tenantId: 'b',
      actor: 'sam',
      action: 'ai.dispatch',
      resource: 'frontier-a',
      purpose: 'summarize',
    });
    expect(audit.records('a').map((r) => r.seq)).toEqual([1, 2]);
    expect(audit.records('b').map((r) => r.seq)).toEqual([3]);
  });

  // Append-only in the interface stops the code above it from deleting a
  // record; it does nothing about the store underneath.
  it('digests the sequence, so a record removed from the middle is visible', () => {
    const first = log().digest();
    const second = log();
    second.write({
      at: 3,
      tenantId: 'a',
      actor: 'maya',
      action: 'ai.dispatch',
      resource: 'open-70b',
      purpose: 'draft',
    });
    expect(second.digest()).not.toBe(first);
  });
});
