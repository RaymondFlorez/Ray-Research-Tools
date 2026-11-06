/**
 * An export bundle as a PDF (PRD 2.3's `export-service`, the walkthrough's
 * "four-page PDF ... with the audit bundle attached as an appendix").
 *
 * The PRD's pipeline is WeasyPrint, which is not here. This writes PDF 1.4
 * directly: text pages in the standard Helvetica faces, no images, no fonts
 * embedded, nothing compressed. That is enough for what the bundle holds,
 * which is figures, the notes on what was withheld or rounded, and the
 * appendix that makes them reproducible. It is checked by `pdftotext`, a
 * reader that shares no code with this one.
 *
 * Two rules carried from the bundle:
 *
 *   - **A redacted cell says so on the page.** Its value is printed as the
 *     bundle holds it (`withheld`, or the rounded figure) with the
 *     redaction note beside it, never a blank.
 *   - **The appendix is always printed.** Dataset snapshot ids, traces, model
 *     versions and the audit trace id go on the last page, even when a list is
 *     empty, where the page says so.
 *
 * Output is deterministic: the same bundle gives the same bytes, so an export
 * can be compared and hashed.
 */

import type { Bundle } from './exportBundle.js';

const PAGE = { width: 612, height: 792, margin: 56 };
const WRAP = 92;

type Line = { text: string; bold?: boolean; size?: number; gapBefore?: number };

/** The characters Helvetica in WinAnsiEncoding prints, with common ones mapped. */
function printable(s: string): string {
  const mapped = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
  return mapped.replace(/[^\x20-\x7e]/g, '?');
}

/** Lines of at most `width` characters, breaking at spaces, and inside a word longer than a line. */
function wrap(text: string, width = WRAP): string[] {
  const out: string[] = [];
  for (const paragraph of printable(text).split('\n')) {
    let line = '';
    for (let word of paragraph.split(' ')) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = '';
      }
      while (word.length > width) {
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

const pdfString = (s: string) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

function linesOf(bundle: Bundle): Line[] {
  const lines: Line[] = [{ text: printable(bundle.title), bold: true, size: 18 }];
  lines.push({ text: `Tenant ${bundle.tenantId} - generated ${new Date(bundle.appendix.generatedAt).toISOString()}`, size: 10 });
  lines.push({ text: 'Figures', bold: true, size: 13, gapBefore: 10 });
  for (const cell of bundle.cells) {
    const value = typeof cell.value === 'number' ? String(cell.value) : cell.value;
    const head = `${cell.label}: ${value}${cell.unit ? ` ${cell.unit}` : ''} (as of ${cell.asof}, ${cell.classification}${cell.vendor ? `, ${cell.vendor}` : ''})`;
    wrap(head).forEach((text, i) => lines.push({ text: i ? `   ${text}` : text }));
    if (cell.redaction) wrap(`   ${cell.redaction.rule === 'strip' ? 'Withheld' : 'Rounded'}: ${cell.redaction.note}`).forEach((text) => lines.push({ text, size: 10 }));
  }
  if (bundle.notices.length) {
    lines.push({ text: 'Notices', bold: true, size: 13, gapBefore: 10 });
    for (const notice of bundle.notices) wrap(notice).forEach((text) => lines.push({ text, size: 10 }));
  }
  return lines;
}

function appendixOf(bundle: Bundle, traceId: string | undefined): Line[] {
  const a = bundle.appendix;
  const list = (heading: string, items: string[]): Line[] => [
    { text: heading, bold: true, gapBefore: 8 },
    ...(items.length ? items.flatMap((i) => wrap(`   ${i}`).map((text) => ({ text, size: 10 }))) : [{ text: '   none', size: 10 }]),
  ];
  return [
    { text: 'Appendix: audit bundle', bold: true, size: 13 },
    ...list('Dataset snapshots', Object.entries(a.datasetSnapshots).sort(([x], [y]) => (x < y ? -1 : 1)).map(([source, id]) => `${source}: ${id}`)),
    ...list('Traces', a.traceIds),
    ...list('Model versions', a.modelVersions),
    ...list('Audit', [...(traceId ? [`export recorded under trace ${traceId}`] : []), ...(a.auditDigest ? [`audit log digest ${a.auditDigest}`] : [])]),
  ];
}

function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const line of lines) {
    const height = (line.size ?? 11) + 3 + (line.gapBefore ?? 0);
    if (y - height < PAGE.margin) {
      pages.push([]);
      y = PAGE.height - PAGE.margin;
    }
    pages[pages.length - 1]!.push(line);
    y -= height;
  }
  return pages;
}

function contentOf(page: Line[], number: number, total: number): string {
  const ops: string[] = ['BT'];
  let y = PAGE.height - PAGE.margin;
  for (const line of page) {
    const size = line.size ?? 11;
    y -= size + 3 + (line.gapBefore ?? 0);
    ops.push(`/${line.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${PAGE.margin} ${y} Tm ${pdfString(line.text)} Tj`);
  }
  ops.push(`/F1 9 Tf 1 0 0 1 ${PAGE.margin} ${PAGE.margin / 2} Tm ${pdfString(`Page ${number} of ${total}`)} Tj`, 'ET');
  return ops.join('\n');
}

/**
 * The bundle as PDF bytes. `traceId` is the audit trail's record of this
 * export, printed in the appendix so the document points at its own record.
 */
export function bundlePdf(bundle: Bundle, options: { traceId?: string } = {}): Uint8Array {
  const pages = [...paginate(linesOf(bundle)), ...paginate(appendixOf(bundle, options.traceId))];
  // Objects: 1 catalog, 2 pages, 3-4 fonts, then a page and its content per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const content = contentOf(page, i + 1, pages.length);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const date = new Date(bundle.appendix.generatedAt).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  objects.push(`<< /Title ${pdfString(printable(bundle.title))} /Producer (Picasso export-service) /CreationDate (D:${date}Z) >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is ASCII (printable() sees to it), so string offsets are byte offsets.
  return new TextEncoder().encode(out);
}
