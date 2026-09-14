/**
 * Export bundles (PRD 2.1, 7.2, 7.4's walkthrough).
 *
 * "Anything Picasso produces that touches a regulated workflow exports through
 * the existing Grand Chessboard reporting pipeline with an audit bundle
 * attached", and from the walkthrough: "a four-page PDF... with the audit
 * bundle (traces, dataset snapshot IDs, model versions) attached as an
 * appendix."
 *
 * Plus the licensing rule: "Exports strip or blur non-redistributable vendor
 * data according to per-vendor rules encoded in the export service."
 *
 * Two decisions worth stating.
 *
 * **Redaction is a value transform, not a deletion.** A stripped cell leaves a
 * gap the reader fills in with a guess; a cell that says "withheld: Vendor X
 * licence does not permit redistribution" tells them there was a number and
 * why they cannot see it. The blur case keeps the magnitude and drops the
 * precision, which is what a redistribution rule usually actually forbids.
 *
 * **A bundle with nothing to trace is refused.** An export whose figures have
 * no dataset snapshot and no trace is not a lighter-weight export, it is an
 * unreproducible one, and attaching an empty appendix to it would be worse
 * than attaching none: it looks like provenance.
 */

import type { Classification } from './classification.js';
import { mustStayInTenant } from './classification.js';
import type { AuditLog } from './audit.js';

export type VendorRule = 'redistributable' | 'strip' | 'blur';

export interface VendorPolicy {
  vendor: string;
  rule: VendorRule;
  /** For `blur`: significant digits kept. */
  precision?: number;
}

export interface ExportCell {
  id: string;
  label: string;
  value: number | string;
  unit?: string;
  vendor?: string;
  classification: Classification;
  /** Iceberg snapshot ids by source, so the figure can be re-derived. */
  datasetSnapshots: Record<string, string>;
  /** Compute trace and any model dispatches behind it. */
  traceIds: string[];
  modelVersions?: string[];
  asof: string;
}

export interface RedactedCell extends Omit<ExportCell, 'value'> {
  value: number | string;
  redaction?: { rule: VendorRule; note: string };
}

export class UnreproducibleExport extends Error {
  constructor(readonly cellId: string) {
    super(`cell ${cellId} carries no dataset snapshot and no trace; it cannot be reproduced`);
    this.name = 'UnreproducibleExport';
  }
}

export class ExportWouldLeak extends Error {
  constructor(readonly cellId: string, classification: Classification) {
    super(`cell ${cellId} is classified ${classification} and this export leaves the tenant`);
    this.name = 'ExportWouldLeak';
  }
}

export interface BundleInput {
  title: string;
  tenantId: string;
  actor: string;
  purpose: string;
  cells: readonly ExportCell[];
  vendorPolicies: readonly VendorPolicy[];
  /** True when the artifact goes to a recipient outside the tenant. */
  leavesTenant: boolean;
  at: number;
  audit?: AuditLog;
}

export interface AuditAppendix {
  datasetSnapshots: Record<string, string>;
  traceIds: string[];
  modelVersions: string[];
  /** The audit log's digest at export time, so the appendix pins the trail. */
  auditDigest?: string;
  generatedAt: number;
}

export interface Bundle {
  title: string;
  tenantId: string;
  cells: RedactedCell[];
  appendix: AuditAppendix;
  /** Lines the export renders below the figures. */
  notices: string[];
}

export function buildBundle(input: BundleInput): Bundle {
  const policies = new Map(input.vendorPolicies.map((p) => [p.vendor, p]));
  const cells: RedactedCell[] = [];
  const notices: string[] = [];
  const snapshots: Record<string, string> = {};
  const traceIds = new Set<string>();
  const modelVersions = new Set<string>();

  for (const cell of input.cells) {
    if (Object.keys(cell.datasetSnapshots).length === 0 && cell.traceIds.length === 0) {
      throw new UnreproducibleExport(cell.id);
    }
    if (input.leavesTenant && mustStayInTenant(cell.classification)) {
      throw new ExportWouldLeak(cell.id, cell.classification);
    }

    for (const [source, snapshot] of Object.entries(cell.datasetSnapshots)) {
      snapshots[source] = snapshot;
    }
    for (const trace of cell.traceIds) traceIds.add(trace);
    for (const version of cell.modelVersions ?? []) modelVersions.add(version);

    cells.push(redact(cell, policies, notices));
  }

  return {
    title: input.title,
    tenantId: input.tenantId,
    cells,
    appendix: {
      datasetSnapshots: snapshots,
      traceIds: [...traceIds].sort(),
      modelVersions: [...modelVersions].sort(),
      ...(input.audit ? { auditDigest: input.audit.digest() } : {}),
      generatedAt: input.at,
    },
    notices: [...new Set(notices)],
  };
}

function redact(
  cell: ExportCell,
  policies: ReadonlyMap<string, VendorPolicy>,
  notices: string[],
): RedactedCell {
  const policy = cell.vendor === undefined ? undefined : policies.get(cell.vendor);
  if (!policy || policy.rule === 'redistributable') return { ...cell };

  if (policy.rule === 'strip') {
    notices.push(`${policy.vendor} data is withheld: the licence does not permit redistribution.`);
    return {
      ...cell,
      value: 'withheld',
      redaction: {
        rule: 'strip',
        note: `${policy.vendor}: not redistributable`,
      },
    };
  }

  // blur
  const precision = policy.precision ?? 2;
  notices.push(`${policy.vendor} figures are rounded: the licence permits indicative values only.`);
  const value =
    typeof cell.value === 'number' ? blurNumber(cell.value, precision) : cell.value;
  return {
    ...cell,
    value,
    redaction: {
      rule: 'blur',
      note: `${policy.vendor}: shown to ${precision} significant digits`,
    },
  };
}

/** Keep the magnitude, drop the precision. */
export function blurNumber(value: number, significant: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (magnitude - significant + 1);
  return Math.round(value / factor) * factor;
}
