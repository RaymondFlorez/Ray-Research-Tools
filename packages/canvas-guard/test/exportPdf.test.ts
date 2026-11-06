/**
 * The PDF writer, read back by `pdftotext` (poppler), which shares no code
 * with it. PICASSO_REQUIRE_PDFTOTEXT=1, as CI sets, makes its absence a
 * failure rather than a skip.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle, type ExportCell } from '../src/exportBundle.js';
import { bundlePdf } from '../src/exportPdf.js';

const cell = (id: string, over: Partial<ExportCell> = {}): ExportCell => ({
  id, label: id, value: 1, classification: 'public', datasetSnapshots: { edgar: 's1' }, traceIds: [], asof: '2024-08-05', ...over,
});
const memo = () => buildBundle({
  title: 'Post-CPI note (NVDA)', tenantId: 'acme', actor: 'pm', purpose: 'export.pdf', leavesTenant: false, at: Date.UTC(2024, 7, 5, 13, 30),
  vendorPolicies: [{ vendor: 'vendor-b', rule: 'strip' }, { vendor: 'vendor-d', rule: 'blur', precision: 2 }],
  cells: [
    cell('rev', { label: 'NVDA revenue', value: 30.04, unit: 'USD bn', traceIds: ['t-rev'] }),
    cell('cap', { label: 'Market cap', value: 2.6e12, classification: 'licensed', vendor: 'vendor-b', datasetSnapshots: { caps: 's2' } }),
    cell('px', { label: 'Close', value: 104.25, classification: 'licensed', vendor: 'vendor-d', modelVersions: ['m-1'] }),
    cell('odd', { label: 'Path a (b) \\ c — é', value: 'n/a' }),
  ],
});

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
let pdftotext: boolean;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  pdftotext = true;
} catch {
  pdftotext = false;
}
if (!pdftotext && process.env.PICASSO_REQUIRE_PDFTOTEXT === '1') throw new Error('PICASSO_REQUIRE_PDFTOTEXT is set and pdftotext is not installed');
const read = (bytes: Uint8Array) => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  writeFileSync(join(dir, 'x.pdf'), bytes);
  return execFileSync('pdftotext', ['-layout', join(dir, 'x.pdf'), '-'], { encoding: 'utf8' });
};

describe('an export bundle as a PDF', () => {
  it('has a cross-reference table whose every offset lands on its object', () => {
    const text = latin1(bundlePdf(memo(), { traceId: 'abc123' }));
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(startxref))!;
    const entries = text.slice(startxref).split('\n').slice(3, 2 + Number(count));
    entries.forEach((entry, i) => expect(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain(`/Size ${count}`);
  });

  it('is the same bytes for the same bundle', () => {
    expect(Buffer.from(bundlePdf(memo())).equals(Buffer.from(bundlePdf(memo())))).toBe(true);
  });

  it.skipIf(!pdftotext)('reads back with the figures, the redactions said, and the appendix', () => {
    const text = read(bundlePdf(memo(), { traceId: 'abc123' }));
    for (const expected of [
      'Post-CPI note (NVDA)',
      'NVDA revenue: 30.04 USD bn (as of 2024-08-05, public)',
      'Market cap: withheld',
      'Withheld: vendor-b: not redistributable',
      'Close: 100',
      'Rounded: vendor-d: shown to 2 significant digits',
      'vendor-b data is withheld: the licence does not permit redistribution.',
      'Path a (b) \\ c - ?',
      'caps: s2',
      'edgar: s1',
      't-rev',
      'm-1',
      'export recorded under trace abc123',
    ]) expect(text).toContain(expected);
  });

  it.skipIf(!pdftotext)('runs onto as many pages as it needs, and numbers them', () => {
    const long = buildBundle({
      title: 'Long', tenantId: 'acme', actor: 'pm', purpose: 'export.pdf', leavesTenant: false, at: 0, vendorPolicies: [],
      cells: Array.from({ length: 150 }, (_, i) => cell(`c${i}`, { label: `Figure ${i}`, value: i })),
    });
    const text = read(bundlePdf(long));
    const pages = Number(/Page 1 of (\d+)/.exec(text)![1]);
    expect(pages).toBeGreaterThan(2);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text).toContain('Figure 149: 149');
    expect(text).toContain('Appendix: audit bundle');
  });
});
