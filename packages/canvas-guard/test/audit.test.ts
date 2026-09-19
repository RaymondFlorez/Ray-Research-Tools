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

// ---------------------------------------------------------------------------
// Regressions from the security review.
// ---------------------------------------------------------------------------

describe('the detail of a record', () => {
  function withDetail(detail: Record<string, string | number | boolean>): AuditLog {
    const audit = new AuditLog();
    audit.write({
      at: 1,
      tenantId: 'a',
      actor: 'maya',
      action: 'override.approve',
      resource: 'node/vega',
      purpose: 'desk head signed off on the model figure',
      traceId: 't-1',
      detail,
    });
    return audit;
  }

  // `{ ...record }` copies the reference to `detail`, not the object. A holder
  // of the record returned by `write` could reach through it and rewrite the
  // detail of an entry already in the append-only log — the exact edit the
  // class exists to prevent, arriving through the copy meant to prevent it.
  it('cannot be rewritten through the record write returns', () => {
    const audit = withDetail({ approver: 'desk-head', model: 'frontier-a' });
    const returned = audit.write({
      at: 2,
      tenantId: 'a',
      actor: 'maya',
      action: 'ai.dispatch',
      resource: 'open-70b',
      purpose: 'draft',
      detail: { model: 'open-70b' },
    });
    returned.detail!.model = 'frontier-a';
    expect(audit.records()[1]?.detail).toEqual({ model: 'open-70b' });
  });

  // Same hole through the other door.
  it('cannot be rewritten through the records read back', () => {
    const audit = withDetail({ approver: 'desk-head' });
    audit.records()[0]!.detail!.approver = 'nobody';
    expect(audit.records()[0]?.detail).toEqual({ approver: 'desk-head' });
  });

  it('cannot be rewritten through the object handed to write', () => {
    const detail = { approver: 'desk-head' };
    const audit = withDetail(detail);
    detail.approver = 'nobody';
    expect(audit.records()[0]?.detail).toEqual({ approver: 'desk-head' });
  });

  // The digest hashed seven fields and skipped `traceId` and `detail`, so a
  // store that rewrote the override reason, the matched fingerprint, or the
  // model a dispatch actually went to produced the digest it had before. A
  // tamper check that does not cover the field most worth tampering with is a
  // check in name only.
  it('is covered by the digest', () => {
    expect(withDetail({ approver: 'desk-head' }).digest()).not.toBe(
      withDetail({ approver: 'nobody' }).digest(),
    );
    expect(withDetail({ approver: 'desk-head' }).digest()).not.toBe(
      withDetail({ approver: 'desk-head', model: 'frontier-a' }).digest(),
    );
    expect(withDetail({ approver: 'desk-head' }).digest()).not.toBe(new AuditLog().digest());
  });

  it('digests the same content the same way whatever order it arrived in', () => {
    const a = withDetail({ approver: 'desk-head', model: 'frontier-a' });
    const b = withDetail({ model: 'frontier-a', approver: 'desk-head' });
    expect(a.digest()).toBe(b.digest());
  });

  it('covers the trace id too', () => {
    const base = {
      at: 1,
      tenantId: 'a',
      actor: 'maya',
      action: 'ai.dispatch' as const,
      resource: 'open-70b',
      purpose: 'draft',
    };
    const one = new AuditLog();
    one.write({ ...base, traceId: 't-1' });
    const two = new AuditLog();
    two.write({ ...base, traceId: 't-2' });
    expect(one.digest()).not.toBe(two.digest());
  });
});
