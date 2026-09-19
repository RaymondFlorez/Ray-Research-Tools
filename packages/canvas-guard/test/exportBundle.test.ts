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

// ---------------------------------------------------------------------------
// Regressions from the security review.
// ---------------------------------------------------------------------------

describe('blurring a value that is not a number', () => {
  // The blur branch transformed numbers and passed strings through untouched,
  // while stamping both `redaction: { rule: 'blur' }`. So `"12,450.38"` left at
  // full precision under a label asserting it had been reduced to two
  // significant digits: the licence breached and the audit record saying it
  // had not been.
  it('does not pass a numeric string through at full precision', () => {
    const [out] = bundle([
      cell({ value: '12,450.38', vendor: 'vendor-indicative', classification: 'licensed' }),
    ]).cells;
    expect(out?.value).not.toBe('12,450.38');
    expect(out?.value).toBe('12000');
  });

  it('keeps the decoration around the number', () => {
    const cases: Array<[string, string]> = [
      ['$12,450.38', '$12000'],
      // Math.round breaks the half toward +Infinity, so -3.75 goes to -3.7.
      ['-3.75%', '-3.7%'],
      ['12450 bp', '12000 bp'],
      ['  4,187  ', '4200'],
    ];
    for (const [input, expected] of cases) {
      const [out] = bundle([
        cell({ value: input, vendor: 'vendor-indicative', classification: 'licensed' }),
      ]).cells;
      expect(out?.value, input).toBe(expected);
      expect(out?.redaction?.rule, input).toBe('blur');
    }
  });

  it('withholds a value it cannot reduce, rather than labelling it blurred', () => {
    for (const value of [
      'up sharply on the print',
      '2026-03-11',
      '12450 and 3318',
      // A number wearing more than a unit is free text, not a figure.
      'NVDA Jan 1400 C',
      '12450 shares of common stock',
    ]) {
      const [out] = bundle([
        cell({ value, vendor: 'vendor-indicative', classification: 'licensed' }),
      ]).cells;
      expect(out?.value, value).toBe('withheld');
      expect(out?.redaction?.rule, value).toBe('strip');
    }
  });

  // The invariant behind both: a redaction record is a claim about what
  // happened to the value, so only the branch that did it writes one.
  it('never claims a transform that did not happen', () => {
    const cells = ['12,450.38', 'up sharply', -3870, 0].map((value) =>
      cell({ value, vendor: 'vendor-indicative', classification: 'licensed' }),
    );
    for (const out of bundle(cells).cells) {
      if (out.redaction?.rule === 'blur') expect(out.value).not.toBe('withheld');
      if (out.redaction?.rule === 'strip') expect(out.value).toBe('withheld');
    }
  });
});

describe('a licensed cell whose policy does not resolve', () => {
  // The mirror of the entitlement hole: `licensed` says redistribution is
  // governed by someone's terms, and an unresolved policy means we do not know
  // whose. Omitting a vendor from `vendorPolicies` — or from the cell — was a
  // way to export exactly the data the policies exist to hold back.
  it('is withheld when the cell names no vendor', () => {
    const [out] = bundle([cell({ classification: 'licensed' })]).cells;
    expect(out?.value).toBe('withheld');
    expect(out?.redaction?.rule).toBe('strip');
  });

  it('is withheld when no policy was supplied for its vendor', () => {
    const [out] = bundle([
      cell({ classification: 'licensed', vendor: 'vendor-nobody-configured' }),
    ]).cells;
    expect(out?.value).toBe('withheld');
    expect(out?.redaction?.rule).toBe('strip');
  });

  it('says so in the notices', () => {
    const notices = bundle([
      cell({ classification: 'licensed', vendor: 'vendor-nobody-configured' }),
    ]).notices;
    expect(notices.some((n) => /no redistribution policy/i.test(n))).toBe(true);
  });

  it('leaves a public cell with no vendor alone', () => {
    const [out] = bundle([cell({ classification: 'public' })]).cells;
    expect(out?.value).toBe(-3870);
    expect(out?.redaction).toBeUndefined();
  });

  it('leaves a licensed cell with a redistributable policy alone', () => {
    const [out] = bundle([
      cell({ classification: 'licensed', vendor: 'vendor-open' }),
    ]).cells;
    expect(out?.value).toBe(-3870);
    expect(out?.redaction).toBeUndefined();
  });
});
