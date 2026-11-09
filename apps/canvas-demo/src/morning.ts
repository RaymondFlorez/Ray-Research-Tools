/**
 * The historical morning (PRD Appendix B phase 1, 3.3, 3.8, 7.2).
 *
 * A ChartNode of one fact series, evaluated at the canvas's time through
 * canvas-data's entitled in-process read and drawn by canvas-render's series
 * renderer. Switching the canvas time redraws what was known then; switching
 * the reader shows a withheld period as a gap. Export PDF sends the drawn
 * figures to the collaboration server's export service, which applies its
 * vendor rules, records the export on the audit trail, and returns a PDF.
 *
 * The figures are SAMPLE data: reported quarters, with synthetic licensed
 * restatements of the June quarter.
 */

import { chartExportCells, chartExportSpec, classifiedSource, createSeriesChart, evaluateSeriesChart, type CanvasTime, type ClassifiedFact, type Entitlements, type SeriesChartValue } from '@picasso/canvas-data';
import { seriesFigure, seriesSvg } from '@picasso/canvas-render';

const FACTS: ClassifiedFact[] = [
  { key: 'NVDA.revenue', validTime: '2024-03-31', knowledgeTime: '2024-05-22', value: 26.04, dataClass: 'public', source: '10-Q' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2024-07-24', value: 30.04, dataClass: 'public', source: '10-Q' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-02-26', value: 29.87, dataClass: 'licensed', vendor: 'vendor-b' },
  { key: 'NVDA.revenue', validTime: '2024-06-30', knowledgeTime: '2025-11-19', value: 29.71, dataClass: 'licensed', vendor: 'vendor-b' },
  { key: 'NVDA.revenue', validTime: '2024-09-30', knowledgeTime: '2024-11-20', value: 35.08, dataClass: 'public', source: '10-Q' },
  { key: 'NVDA.revenue', validTime: '2024-12-31', knowledgeTime: '2025-02-26', value: 39.33, dataClass: 'public', source: '10-K' },
  { key: 'NVDA.revenue', validTime: '2025-03-31', knowledgeTime: '2025-05-28', value: 44.06, dataClass: 'public', source: '10-Q' },
];
const MORNING = '2024-08-05T09:30:00Z';
const READERS: Record<string, Entitlements> = {
  pm: { userId: 'pm', tenantId: 'dev', vendors: new Set(['vendor-b']), positions: true, mnpi: false },
  analyst: { userId: 'analyst', tenantId: 'dev', vendors: new Set(), positions: false, mnpi: false },
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const timePicker = $('time') as HTMLSelectElement;
const userPicker = $('user') as HTMLSelectElement;
const exportStatus = $('export-status');

let drawn: SeriesChartValue & { kind: 'series' } | undefined;

async function draw(): Promise<void> {
  const time: CanvasTime = timePicker.value === 'morning' ? { mode: 'pinned', asof: MORNING } : { mode: 'live' };
  const node = createSeriesChart({ id: 'nvda-revenue', key: 'NVDA.revenue' });
  const v = await evaluateSeriesChart(node, classifiedSource(FACTS, READERS[userPicker.value]!), time, () => new Date().toISOString());
  if (v.kind !== 'series') return;
  drawn = v;
  const width = Math.min(700, Math.max(320, $('chart').clientWidth - 16));
  $('chart').innerHTML = seriesSvg(seriesFigure(v.points, { width, height: 260 }), `NVDA revenue as of ${v.asof}`);
  $('rows').innerHTML = v.points
    .map((p) => 'withheld' in p
      ? `<tr><td>${p.validTime}</td><td class="withheld" colspan="2">withheld: ${p.withheld}</td></tr>`
      : `<tr><td>${p.validTime}</td><td>${p.value.toFixed(2)}</td><td>${p.knownAt}</td></tr>`)
    .join('');
}

/** The figures on screen, as export cells, each with the class and vendor its read carried. */
const cells = (d: SeriesChartValue & { kind: 'series' }) =>
  chartExportCells(d, { label: 'NVDA revenue', unit: 'USD bn', datasetSnapshots: { 'nvda-revenue sample': `as of ${d.asof}` } });

$('export').addEventListener('click', async () => {
  if (!drawn) return;
  exportStatus.textContent = 'exporting';
  try {
    const res = await fetch('/collab/v1/exports?doc=dev%2Fmorning&format=pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Picasso-User': userPicker.value, 'X-Picasso-Purpose': 'export.pdf' },
      body: JSON.stringify({ title: `NVDA revenue as of ${drawn.asof}`, leavesTenant: false, cells: cells(drawn), charts: [chartExportSpec(drawn, 'NVDA revenue, USD bn')] }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      exportStatus.textContent = `export refused (${res.status}): ${body.error ?? 'the export service did not answer'}`;
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nvda-revenue.pdf';
    link.textContent = 'save the PDF again';
    exportStatus.replaceChildren(`exported; recorded on the audit trail under trace ${res.headers.get('x-picasso-trace')} · `, link);
    link.click();
  } catch (err) {
    exportStatus.textContent = `export failed: ${(err as Error).message}`;
  }
});

timePicker.addEventListener('change', () => void draw());
userPicker.addEventListener('change', () => void draw());
void draw().then(() => {
  (window as unknown as { __morning: unknown }).__morning = {
    ready: true,
    markers: () => document.querySelectorAll('#chart circle.marker').length,
    gaps: () => Array.from(document.querySelectorAll('#chart rect.gap title'), (t) => t.textContent),
    segments: () => document.querySelectorAll('#chart polyline.line').length,
    values: () => drawn?.points.map((p) => ('value' in p ? p.value : null)),
    redraw: () => draw(),
  };
});
