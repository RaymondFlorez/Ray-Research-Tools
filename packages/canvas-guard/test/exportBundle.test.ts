import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';
import {
  ExportWouldLeak,
  UnreproducibleExport,
  blurNumber,
  buildBundle,
  type ExportCell,
  type VendorPolicy,
} from '../src/exportBundle.js';

const policies: VendorPolicy[] = [
  { vendor: 'vendor-open', rule: 'redistributable' },
  { vendor: 'vendor-strict', rule: 'strip' },
  { vendor: 'vendor-indicative', rule: 'blur', precision: 2 },
];

function cell(overrides: Partial<ExportCell> = {}): ExportCell {
  return {
    id: 'c1',
    label: 'portfolio vega',
    value: -3870,
    unit: 'usd',
    classification: 'public',
    datasetSnapshots: { positions: 'snap-9912' },
    traceIds: ['trace-1'],
    asof: '2026-03-11',
    ...overrides,
  };
}

function bundle(cells: ExportCell[], leavesTenant = false, audit?: AuditLog) {
  return buildBundle({
    title: 'post-Q4-hawkish',
    tenantId: 'a',
    actor: 'maya',
    purpose: 'share with partner',
    cells,
    vendorPolicies: policies,
    leavesTenant,
    at: 1_772_000_000_000,
    ...(audit ? { audit } : {}),
  });
}

describe('the audit appendix', () => {
  it('carries traces, dataset snapshot ids and model versions', () => {
    const result = bundle([
      cell(),
      cell({
        id: 'c2',
        datasetSnapshots: { prices: 'snap-441' },
        traceIds: ['trace-2'],
        modelVersions: ['frontier-a@2026-02-01'],
      }),
    ]);
    expect(result.appendix.datasetSnapshots).toEqual({ positions: 'snap-9912', prices: 'snap-441' });
    expect(result.appendix.traceIds).toEqual(['trace-1', 'trace-2']);
    expect(result.appendix.modelVersions).toEqual(['frontier-a@2026-02-01']);
  });

  it('pins the audit trail\'s digest at export time', () => {
    const audit = new AuditLog();
    audit.write({
      at: 1,
      tenantId: 'a',
      actor: 'maya',
      action: 'export.create',
      resource: 'canvas/post-q4',
      purpose: 'share with partner',
    });
    expect(bundle([cell()], false, audit).appendix.auditDigest).toBe(audit.digest());
  });

  // An export whose figures have no snapshot and no trace is not a
  // lighter-weight export, it is an unreproducible one, and an empty appendix
  // would be worse than none: it looks like provenance.
  it('refuses a figure that cannot be reproduced', () => {
    expect(() => bundle([cell({ datasetSnapshots: {}, traceIds: [] })])).toThrow(UnreproducibleExport);
  });
});

describe('an export that leaves the tenant', () => {
  it('refuses a figure classified at or above positions', () => {
    expect(() => bundle([cell({ classification: 'positions' })], true)).toThrow(ExportWouldLeak);
    expect(() => bundle([cell({ classification: 'mnpi_risk' })], true)).toThrow(ExportWouldLeak);
  });

  it('allows the same figure to an internal recipient', () => {
    expect(() => bundle([cell({ classification: 'positions' })], false)).not.toThrow();
  });
});

describe('vendor licence rules', () => {
  // A stripped cell leaves a gap the reader fills in with a guess. A cell that
  // says why there is no number does not.
  it('replaces a stripped value with a stated withholding, not a blank', () => {
    const result = bundle([cell({ vendor: 'vendor-strict' })]);
    expect(result.cells[0]?.value).toBe('withheld');
    expect(result.cells[0]?.redaction?.note).toContain('not redistributable');
    expect(result.notices[0]).toContain('does not permit redistribution');
  });

  it('keeps the magnitude and drops the precision when a licence says indicative', () => {
    const result = bundle([cell({ vendor: 'vendor-indicative', value: -3870 })]);
    expect(result.cells[0]?.value).toBe(-3900);
    expect(result.notices[0]).toContain('rounded');
  });

  it('leaves a redistributable vendor alone', () => {
    const result = bundle([cell({ vendor: 'vendor-open' })]);
    expect(result.cells[0]?.value).toBe(-3870);
    expect(result.cells[0]?.redaction).toBeUndefined();
  });

  it('leaves a cell with no vendor alone', () => {
    expect(bundle([cell()]).cells[0]?.redaction).toBeUndefined();
  });

  it('states each notice once however many cells it covers', () => {
    const result = bundle([
      cell({ id: 'c1', vendor: 'vendor-strict' }),
      cell({ id: 'c2', vendor: 'vendor-strict' }),
    ]);
    expect(result.notices).toHaveLength(1);
  });
});

describe('blurring', () => {
  it('keeps the requested significant digits', () => {
    expect(blurNumber(-3870, 2)).toBe(-3900);
    expect(blurNumber(12_450, 2)).toBe(12_000);
    expect(blurNumber(0.06234, 2)).toBeCloseTo(0.062, 6);
    expect(blurNumber(0, 2)).toBe(0);
  });
});
