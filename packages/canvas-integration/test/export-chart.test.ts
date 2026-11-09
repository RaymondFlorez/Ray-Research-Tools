/**
 * A chart on screen, exported: canvas-data reads and builds the cells,
 * canvas-render draws, canvas-guard redacts and writes the PDF.
 *
 * The seam that matters is classification. The export service applies the
 * vendor rules by each cell's class and vendor, and the cells are built from
 * what the chart read. The first version of this path lost both on the way:
 * `SourceRead` kept a figure's period, value and knowledge time and dropped
 * its class, so a chart read through the data plane had nothing to tell the
 * export service. The demo page only worked because it looked each class up
 * again in its own copy of the facts. These tests hold the class to the whole
 * path, from either source.
 */

import { describe, expect, it } from 'vitest';
import {
  BitemporalStore,
  chartExportCells,
  chartExportSpec,
  classifiedSource,
  createSeriesChart,
  evaluateSeriesChart,
  localSource,
  remoteSource,
  RemotePointInTime,
  type ClassifiedFact,
  type Entitlements,
  type PointInTimeSource,
} from '@picasso/canvas-data';
import { seriesFigure } from '@picasso/canvas-render';
import { buildBundle, bundlePdf, chartPoints, type ExportCell } from '@picasso/canvas-guard';

const FACTS: ClassifiedFact[] = [
  { key: 'NVDA.revenue', validTime: '2024-03-31', knowledgeTime: '2024-05-22', value: 26.04, dataClass: 'public' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, dataClass: 'public' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, dataClass: 'licensed', vendor: 'vendor-b' },
  { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08, dataClass: 'public' },
];
const PM: Entitlements = { userId: 'pm', tenantId: 'dev', vendors: new Set(['vendor-b']), positions: true, mnpi: false };
const ANALYST: Entitlements = { userId: 'analyst', tenantId: 'dev', vendors: new Set(), positions: false, mnpi: false };
const LIVE = { mode: 'live' as const };
const NOW = () => '2026-11-09T00:00:00Z';

const chartFrom = async (source: PointInTimeSource) => {
  const v = await evaluateSeriesChart(createSeriesChart({ id: 'c', key: 'NVDA.revenue' }), source, LIVE, NOW);
  if (v.kind !== 'series') throw new Error('superseded');
  return v;
};
const cellsOf = (v: Awaited<ReturnType<typeof chartFrom>>) =>
  chartExportCells(v, { label: 'NVDA revenue', unit: 'USD bn', datasetSnapshots: { sample: 'v1' } }) as ExportCell[];
const exportOf = (cells: ExportCell[], vendorPolicies: Parameters<typeof buildBundle>[0]['vendorPolicies']) =>
  buildBundle({ title: 'NVDA revenue', tenantId: 'dev', actor: 'pm', purpose: 'export.pdf', leavesTenant: false, at: 0, cells, vendorPolicies });

/** The data plane as the Go service answers, for the licensed reader. */
function dataPlane(): RemotePointInTime {
  const body = {
    observations: [
      { validTime: '2024-03-31', value: 26.04, knownAt: '2024-05-22', dataClass: 'public' },
      { validTime: '2024-06-30', value: 29.87, knownAt: '2025-02-26', dataClass: 'licensed', vendor: 'vendor-b' },
      { validTime: '2024-09-30', value: 35.08, knownAt: '2024-11-20', dataClass: 'public' },
    ],
    blocked: [],
  };
  return new RemotePointInTime({ baseUrl: 'http://dp', user: 'pm', fetch: (async () => new Response(JSON.stringify(body))) as typeof fetch });
}

describe('a chart on screen, exported', () => {
  it('exports what it draws: one cell per marker, nothing for a gap', async () => {
    const chart = await chartFrom(classifiedSource(FACTS, ANALYST));
    const figure = seriesFigure(chart.points, { width: 600, height: 240 });
    const cells = cellsOf(chart);
    expect(cells.map((c) => c.id)).toEqual(figure.markers.map((m) => `NVDA.revenue@${m.validTime}`));
    expect(figure.gaps.map((g) => g.validTime)).toEqual(['2024-06-30']);
    expect(cells.some((c) => c.id.endsWith('2024-06-30'))).toBe(false);
  });

  it('carries each figure\'s class from the data plane, as from the in-process read', async () => {
    const remote = cellsOf(await chartFrom(remoteSource(dataPlane())));
    const inProcess = cellsOf(await chartFrom(classifiedSource(FACTS, PM)));
    expect(remote).toEqual(inProcess);
    expect(remote.find((c) => c.id.endsWith('2024-06-30'))).toMatchObject({ classification: 'licensed', vendor: 'vendor-b', value: 29.87 });
  });

  it('applies the vendor rule to the licensed figure, and only to it, through to the PDF', async () => {
    const cells = cellsOf(await chartFrom(remoteSource(dataPlane())));
    const stripped = exportOf(cells, [{ vendor: 'vendor-b', rule: 'strip' }]);
    expect(stripped.cells.map((c) => c.value)).toEqual([26.04, 'withheld', 35.08]);
    const allowed = exportOf(cells, [{ vendor: 'vendor-b', rule: 'redistributable' }]);
    expect(allowed.cells.map((c) => c.value)).toEqual([26.04, 29.87, 35.08]);
    const pdf = Buffer.from(bundlePdf(stripped)).toString('latin1');
    expect(pdf).toContain('(NVDA revenue 2024-06-30: withheld');
    expect(pdf).not.toContain('29.87');
  });

  it('withholds a figure whose class its source never said, rather than calling it public', async () => {
    const bare = new BitemporalStore<number>();
    bare.appendAll(FACTS.map(({ dataClass: _c, vendor: _v, ...f }) => f));
    const cells = cellsOf(await chartFrom(localSource(bare)));
    expect(cells.every((c) => c.classification === 'licensed' && c.vendor === undefined)).toBe(true);
    expect(exportOf(cells, [{ vendor: 'vendor-b', rule: 'redistributable' }]).cells.every((c) => c.value === 'withheld')).toBe(true);
  });

  it('draws the exported chart from what the export allows: the screen\'s gaps, and the vendor rule\'s', async () => {
    const chart = await chartFrom(classifiedSource(FACTS, PM));
    const bundle = exportOf(cellsOf(chart), [{ vendor: 'vendor-b', rule: 'strip' }]);
    const points = chartPoints(bundle, chartExportSpec(chart, 'NVDA revenue'));
    expect(points).toEqual([
      { validTime: '2024-03-31', value: 26.04 },
      { validTime: '2024-06-30', withheld: 'vendor-b: not redistributable' },
      { validTime: '2024-09-30', value: 35.08 },
    ]);
    const figure = seriesFigure(points, { width: 500, height: 260 });
    expect(figure.markers.map((m) => m.value)).toEqual([26.04, 35.08]);
    // The analyst's own gap on screen stays a gap in the export.
    const analyst = await chartFrom(classifiedSource(FACTS, ANALYST));
    const theirs = chartPoints(exportOf(cellsOf(analyst), []), chartExportSpec(analyst, 'NVDA revenue'));
    expect(theirs[1]).toEqual({ validTime: '2024-06-30', withheld: 'Requires a vendor-b licence.' });
  });
});
