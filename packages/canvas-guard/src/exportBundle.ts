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

  // A cell stamped `licensed` whose policy did not resolve — no vendor on the
  // cell, or a vendor the caller passed no policy for — is withheld, not
  // passed through. The stamp says redistribution is governed by terms; an
  // unresolved policy means we do not know which terms, and the export leaves
  // the building either way. Omitting a vendor from `vendorPolicies` was
  // otherwise a way to export exactly the data the policies exist to hold back.
  if (!policy) {
    if (cell.classification === 'licensed') {
      const who = cell.vendor ?? 'an unrecorded vendor';
      notices.push(`Data from ${who} is withheld: no redistribution policy was supplied for it.`);
      return {
        ...cell,
        value: 'withheld',
        redaction: { rule: 'strip', note: `${who}: no redistribution policy on file` },
      };
    }
    return { ...cell };
  }

  if (policy.rule === 'redistributable') return { ...cell };

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
  const blurred = blurValue(cell.value, precision);

  // A value that could not be blurred is stripped. The first version passed a
  // string through untouched and still attached `redaction: { rule: 'blur' }`
  // to it, so `"12,450.38"` left at full precision under a label asserting it
  // had been reduced to two significant digits — the licence breached and the
  // audit record saying it had not been. A redaction record is a claim about
  // what happened to the value, so it is only ever written by the branch that
  // actually did it, and a transform that cannot be performed falls back to the
  // stricter rule rather than the weaker one.
  if (blurred === undefined) {
    notices.push(
      `${policy.vendor} data is withheld: its value could not be reduced in precision.`,
    );
    return {
      ...cell,
      value: 'withheld',
      redaction: {
        rule: 'strip',
        note: `${policy.vendor}: not reducible to ${precision} significant digits, withheld`,
      },
    };
  }

  notices.push(`${policy.vendor} figures are rounded: the licence permits indicative values only.`);
  return {
    ...cell,
    value: blurred,
    redaction: {
      rule: 'blur',
      note: `${policy.vendor}: shown to ${precision} significant digits`,
    },
  };
}

/**
 * Blur a cell value, or report that it cannot be blurred.
 *
 * Numbers go straight through `blurNumber`. A string is blurred only when it is
 * a single number wearing decoration — `"$12,450.38"`, `"12450 bp"`, `"-3.75%"`
 * — in which case the decoration is kept and the number inside it is reduced.
 * Anything else (a sentence, a date, two numbers, a contract label) returns
 * `undefined` and the caller strips it: guessing which digits in free text are
 * the licensed figure is how a redaction misses one.
 *
 * The decoration is deliberately narrow — a currency mark in front, a unit of
 * at most a few characters behind. An earlier pass allowed any non-digit text
 * on either side, which made `"NVDA Jan 1400 C"` a number wearing decoration:
 * the strike blurred to itself and an option label went out labelled `blur`.
 * Free text that happens to contain one number is not a figure, and the export
 * withholds it rather than deciding which part of it was licensed.
 */
function blurValue(value: number | string, significant: number): number | string | undefined {
  if (typeof value === 'number') return blurNumber(value, significant);

  const match = /^([\s$\u20ac\u00a3\u00a5]{0,3})(-?\d[\d,]*(?:\.\d+)?)([\s%a-zA-Z]{0,4})$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const prefix = match[1] ?? '';
  const digits = match[2] ?? '';
  const suffix = match[3] ?? '';
  const parsed = Number.parseFloat(digits.replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return undefined;
  return `${prefix}${blurNumber(parsed, significant)}${suffix}`;
}

/** Keep the magnitude, drop the precision. */
export function blurNumber(value: number, significant: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (magnitude - significant + 1);
  return Math.round(value / factor) * factor;
}
