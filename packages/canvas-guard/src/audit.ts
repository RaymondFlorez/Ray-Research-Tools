/**
 * The audit trail (PRD 7.2).
 *
 * "Every read of position data, every export, and every AI dispatch writes an
 * append-only audit record with actor, resource, purpose, and trace ID. Audit
 * records go to a separate store with a distinct retention policy and no
 * delete path for application service accounts."
 *
 * "No delete path" is a property of an interface, not a policy document. So
 * `AuditLog` has no delete, no truncate, no clear, and no way to reach the
 * backing array: `records()` returns copies. A service account holding this
 * object can write and read and nothing else, which is the guarantee the
 * sentence is asking for, expressed where it cannot be forgotten.
 *
 * `purpose` is required and non-empty for the same reason the override reason
 * in `canvas-agents` is: an audit record that says who read what and when, but
 * not why, answers the easy half of every question anyone asks of it.
 */

export type AuditAction =
  | 'position.read'
  | 'export.create'
  | 'ai.dispatch'
  | 'egress.block'
  | 'override.approve'
  | 'tenant.denied';

export interface AuditRecord {
  seq: number;
  at: number;
  tenantId: string;
  /** The person, not the service. A service account acting alone is a finding. */
  actor: string;
  action: AuditAction;
  /** What was touched: a node id, a canvas id, a model id, a dataset. */
  resource: string;
  /** Why. Required. */
  purpose: string;
  traceId?: string;
  detail?: Record<string, string | number | boolean>;
}

export class IncompleteAuditRecord extends Error {
  constructor(field: string) {
    super(`an audit record must carry ${field}`);
    this.name = 'IncompleteAuditRecord';
  }
}

export class AuditLog {
  private readonly entries: AuditRecord[] = [];

  write(record: Omit<AuditRecord, 'seq'>): AuditRecord {
    if (record.actor.trim() === '') throw new IncompleteAuditRecord('an actor');
    if (record.purpose.trim() === '') throw new IncompleteAuditRecord('a purpose');
    if (record.resource.trim() === '') throw new IncompleteAuditRecord('a resource');
    if (record.tenantId.trim() === '') throw new IncompleteAuditRecord('a tenant');
    const stored = copy({ ...record, seq: this.entries.length + 1 });
    this.entries.push(stored);
    return copy(stored);
  }

  /** Copies, so a holder cannot edit history through the array it was handed. */
  records(tenantId?: string): AuditRecord[] {
    return this.entries
      .filter((e) => tenantId === undefined || e.tenantId === tenantId)
      .map(copy);
  }

  count(): number {
    return this.entries.length;
  }

  /**
   * The chain the record set hashes to.
   *
   * Append-only in the interface stops the code above it from deleting a
   * record; it does nothing about the store underneath. A digest over the
   * sequence lets a later reader notice that something was removed from the
   * middle, which is the failure the separate store and retention policy are
   * guarding against.
   */
  digest(): string {
    let h = 0x811c9dc5;
    for (const entry of this.entries) {
      const line = `${entry.seq}|${entry.at}|${entry.tenantId}|${entry.actor}|${entry.action}|${entry.resource}|${entry.purpose}|${entry.traceId ?? ''}|${detailLine(entry.detail)}`;
      for (let i = 0; i < line.length; i += 1) {
        h ^= line.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h.toString(16).padStart(8, '0');
  }
}

/**
 * A record, copied deep enough that no reference is shared with the log.
 *
 * `{ ...record }` is not deep enough: `detail` is an object, and a spread
 * copies the reference to it. A caller holding a record from `write` or
 * `records` could reach through that reference and rewrite the detail of an
 * entry already in the append-only log — which is exactly the edit the class
 * exists to make impossible, arriving through the copy that was supposed to
 * prevent it. `detail`'s values are primitives by type, so one more level is
 * all it takes.
 */
function copy(record: AuditRecord): AuditRecord {
  return record.detail === undefined ? { ...record } : { ...record, detail: { ...record.detail } };
}

/**
 * `detail`, flattened for the digest, with keys in a fixed order.
 *
 * The digest used to hash seven fields and skip `traceId` and `detail`, so a
 * store that rewrote the detail of a record — the override reason, the matched
 * fingerprint, the model the dispatch actually went to — produced the same
 * digest as before the rewrite. A tamper check that does not cover the field
 * most worth tampering with is a check in name only. Keys are sorted so the
 * digest depends on the content and not on insertion order.
 */
function detailLine(detail: AuditRecord['detail']): string {
  if (detail === undefined) return '';
  return Object.keys(detail)
    .sort()
    .map((k) => `${k}=${String(detail[k])}`)
    .join(',');
}
