import { describe, expect, it } from 'vitest';
import { createDocument, createNode, type CanvasDocument, type NodeID } from '@picasso/canvas-core';
import { renderTextPad, transclusions, type PortReading } from '../src/transclude.js';

const NOW = Date.UTC(2026, 2, 11, 21, 0, 0);

function canvas(): CanvasDocument {
  const doc = createDocument('c');
  const add = (id: string, binding: 'loose' | 'bound' | 'wired', status: 'ready' | 'stale' | 'error' | 'unverified' = 'ready') => {
    const node = createNode({ id, kind: 'DataTile', binding, position: { x: 0, y: 0 } });
    node.state.status = status;
    if (status === 'error') node.state.error = { code: 'feed', message: 'vendor timeout', retriable: true };
    doc.nodes.set(node.id, node);
  };
  add('vega', 'wired');
  add('gm', 'wired', 'stale');
  add('guide', 'wired', 'unverified');
  add('note', 'loose');
  add('broken', 'wired', 'error');
  return doc;
}

const readings = new Map<string, PortReading>([
  ['vega.out', { value: -3870, origin: { source: 'portfolio vega (aggregation node)', asof: '2026-03-11T20:58:00Z', asofMs: NOW - 120_000 } }],
  ['gm.out', { value: '71.2%', origin: { source: 'Q4 segment GM', asof: '2026-02-26', asofMs: NOW - 13 * 86_400_000 } }],
  ['guide.out', { value: 'range', origin: { source: 'guidance extractor', asof: '2026-03-11T20:41:00Z', asofMs: NOW - 19 * 60_000 } }],
  ['vega.bad', { value: 1, origin: { source: '', asof: '2026-03-11', asofMs: NOW } }],
]);
const read = (nodeId: NodeID, portId: string) => readings.get(`${nodeId}.${portId}`);

describe('TextPad transclusion (PRD 3.3)', () => {
  it('finds every reference, with the PRD\'s node.output.value form', () => {
    const refs = transclusions('Vega is {{vega.out.value}}; as of {{vega.out.asof}}; {{ gm.out }}.');
    expect(refs.map((r) => [r.nodeId, r.portId, r.field])).toEqual([
      ['vega', 'out', 'value'],
      ['vega', 'out', 'asof'],
      ['gm', 'out', 'value'],
    ]);
  });

  it('renders each number through present(), with its caption available', () => {
    const pad = renderTextPad('Total vega is {{vega.out}} ({{vega.out.source}}).', canvas(), read, NOW);
    expect(pad.text).toBe('Total vega is -3870 (portfolio vega (aggregation node)).');
    expect(pad.parts[0]!.presented!.caption).toBe('portfolio vega (aggregation node) · 2m old');
  });

  it('marks stale and unverified values instead of hiding them', () => {
    const pad = renderTextPad('GM {{gm.out}}, guide {{guide.out}}.', canvas(), read, NOW);
    expect(pad.text).toBe('GM 71.2% (stale), guide range (unverified).');
    expect(pad.parts.map((p) => p.qualifier)).toEqual(['stale', 'unverified']);
  });

  it('never fills a hole silently', () => {
    const pad = renderTextPad(
      '{{gone.out}} | {{note.out}} | {{broken.out}} | {{vega.missing}} | {{vega.bad}}',
      canvas(),
      read,
      NOW,
    );
    expect(pad.text).toBe(
      '[missing: gone] | [not computed: note is loose] | [error in broken: vendor timeout] | ' +
        '[not computed: vega.missing] | [no provenance: vega.bad]',
    );
    expect(pad.parts.map((p) => p.problem)).toEqual(['missing', 'loose', 'error', 'not_computed', 'no_provenance']);
  });

  it('is live by re-rendering: a changed upstream value is a changed paragraph', () => {
    const doc = canvas();
    const before = renderTextPad('Vega {{vega.out}}', doc, read, NOW).text;
    const after = renderTextPad(
      'Vega {{vega.out}}',
      doc,
      (id, port) => (id === 'vega' && port === 'out' ? { ...readings.get('vega.out')!, value: -4012 } : undefined),
      NOW,
    ).text;
    expect([before, after]).toEqual(['Vega -3870', 'Vega -4012']);
  });

  it('leaves text without references alone', () => {
    expect(renderTextPad('No braces { here }.', canvas(), read, NOW)).toEqual({ text: 'No braces { here }.', parts: [] });
  });
});
