/**
 * The PDF writer, read back by `pdftotext` (poppler), which shares no code
 * with it. PICASSO_REQUIRE_PDFTOTEXT=1, as CI sets, makes its absence a
 * failure rather than a skip.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle, type ExportCell } from '../src/exportBundle.js';
import { bundlePdf, chartPoints, PDF_CHART_COLORS, type PdfChart } from '../src/exportPdf.js';

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

/** A page rasterised by poppler at 72 dpi, so one PDF unit is one pixel. */
function raster(bytes: Uint8Array, page: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ppm-'));
  writeFileSync(join(dir, 'x.pdf'), bytes);
  execFileSync('pdftoppm', ['-r', '72', '-f', String(page), '-l', String(page), '-singlefile', join(dir, 'x.pdf'), join(dir, 'p')]);
  const ppm = readFileSync(join(dir, 'p.ppm'));
  const [magic, w, , max] = ppm.toString('latin1', 0, 32).split(/\s+/);
  if (magic !== 'P6' || max !== '255') throw new Error('unexpected raster');
  const header = ppm.indexOf('255', 2) + 4;
  return (x: number, yFromTop: number) => {
    const i = header + (Math.round(yFromTop) * Number(w) + Math.round(x)) * 3;
    return [ppm[i]!, ppm[i + 1]!, ppm[i + 2]!];
  };
}
const near = (px: number[], rgb: readonly number[]) => px.every((v, i) => Math.abs(v - rgb[i]! * 255) < 40);

describe('a chart in an export', () => {
  it('draws from the redacted cells: a withheld figure is a gap with its note, a rounded one sits at its rounded value', () => {
    const bundle = memo();
    const points = chartPoints(bundle, {
      title: 'x',
      points: [
        { validTime: '2024-03-31', cellId: 'rev' },
        { validTime: '2024-06-30', cellId: 'cap' },
        { validTime: '2024-09-30', withheld: 'Requires a vendor-b licence.' },
        { validTime: '2024-12-31', cellId: 'px' },
      ],
    });
    expect(points).toEqual([
      { validTime: '2024-03-31', value: 30.04 },
      { validTime: '2024-06-30', withheld: 'vendor-b: not redistributable' },
      { validTime: '2024-09-30', withheld: 'Requires a vendor-b licence.' },
      { validTime: '2024-12-31', value: 100 },
    ]);
    expect(() => chartPoints(bundle, { title: 'x', points: [{ validTime: '2024-03-31', cellId: 'nope' }] })).toThrow(/does not hold: nope/);
  });

  it.skipIf(!pdftotext)('puts the line, the markers and the gap where the geometry says, read back from the rendered page', () => {
    const figure: PdfChart['figure'] = {
      width: 400, height: 200, plot: { left: 40, right: 390, top: 10, bottom: 170 },
      segments: [[[60, 150], [160, 150], [160, 60], [200, 60]]],
      markers: [{ x: 60, y: 150 }, { x: 160, y: 60 }],
      gaps: [{ x0: 260, x1: 330, reason: 'Requires a vendor-b licence.' }],
      xTicks: [{ x: 60, label: '2024-03-31' }], yTicks: [{ y: 170, label: '25' }, { y: 10, label: '45' }],
    };
    const bytes = bundlePdf(memo(), { charts: [{ title: 'NVDA revenue', figure }] });
    const pages = Number(/Page 1 of (\d+)/.exec(read(bytes))![1]);
    const chartPage = pages - 1; // figures, chart, appendix
    const at = raster(bytes, chartPage);
    // The page places the figure at the left margin, 34pt below the top margin, unscaled (400 < 500).
    const px = (x: number, y: number) => at(56 + x, 56 + 34 + y);
    expect(near(px(60, 150), PDF_CHART_COLORS.line)).toBe(true);
    expect(near(px(160, 60), PDF_CHART_COLORS.line)).toBe(true);
    expect(near(px(110, 150), PDF_CHART_COLORS.line)).toBe(true);
    expect(near(px(295, 90), PDF_CHART_COLORS.gap)).toBe(true);
    expect(near(px(295, 150), PDF_CHART_COLORS.line)).toBe(false);
    expect(near(px(110, 100), [1, 1, 1])).toBe(true);
    const text = read(bytes);
    expect(text).toContain('NVDA revenue');
    expect(text).toContain('Gap 1: Requires a vendor-b licence.');
    expect(text).toContain(`Page ${chartPage} of ${pages}`);
  });
});
