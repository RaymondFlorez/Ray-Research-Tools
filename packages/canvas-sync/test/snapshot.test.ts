import { describe, expect, it } from 'vitest';
import { SyncedCanvas } from '../src/canvas.js';
import { Link } from '../src/transport.js';
import {
  createNamedVersion,
  encodeSnapshot,
  openVersion,
  restoreSnapshot,
  stripInstrumentBindings,
} from '../src/snapshot.js';
import { edge, node, structure } from './helpers.js';

function built(): SyncedCanvas {
  const canvas = new SyncedCanvas({ id: 'semis' });
  canvas.addNode(node('nvda', { params: { ticker: 'NVDA', label: 'Semis anchor' } }));
  canvas.addNode(node('scenario', { kind: 'ScenarioNode', params: { shockBps: 50 } }));
  canvas.addEdge(edge('e1', 'nvda', 'scenario'));
  canvas.addStroke({ id: 's1', runs: [{ points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }] }] });
  return canvas;
}

describe('snapshots (PRD 3.9)', () => {
  it('round-trips the whole document', () => {
    const canvas = built();
    const restored = restoreSnapshot(encodeSnapshot(canvas));
    expect(structure(restored)).toBe(structure(canvas));
    expect(restored.id).toBe('semis');
  });

  it('restores into a document that can keep collaborating', () => {
    const canvas = built();
    const restored = restoreSnapshot(encodeSnapshot(canvas));
    new Link(canvas.doc, restored.doc);

    restored.addNode(node('added-after-restore'));
    expect(canvas.getNode('added-after-restore')).toBeDefined();
    expect(structure(canvas)).toBe(structure(restored));
  });
});

describe('named versions (PRD 3.9)', () => {
  it('is immutable: later edits do not change what the version holds', () => {
    const canvas = built();
    const version = createNamedVersion(canvas, {
      name: 'pre-CPI',
      createdBy: 'maya',
      datasetSnapshots: { clickhouse: 'snap-42', iceberg: 'snap-7' },
      asof: '2026-02-01T13:29:00Z',
      now: 1_700_000_000_000,
    });

    canvas.addNode(node('added-later'));
    canvas.setParam('nvda', 'ticker', 'AMD');

    const reopened = openVersion(version);
    expect(reopened.getNode('added-later')).toBeUndefined();
    expect(reopened.getNode('nvda')?.params.ticker).toBe('NVDA');
  });

  it('carries the dataset snapshot IDs, without which it is not reproducible', () => {
    const version = createNamedVersion(built(), {
      name: 'bear case',
      createdBy: 'maya',
      datasetSnapshots: { clickhouse: 'snap-42' },
      asof: '2026-02-01T13:29:00Z',
      note: 'before the hawkish repricing',
    });
    // The structure alone would recompute against today's data.
    expect(version.datasetSnapshots).toEqual({ clickhouse: 'snap-42' });
    expect(version.asof).toBe('2026-02-01T13:29:00Z');
    expect(version.note).toBe('before the hawkish repricing');
  });

  it('does not let a caller mutate the version through the input it passed', () => {
    const snapshots = { clickhouse: 'snap-42' };
    const version = createNamedVersion(built(), {
      name: 'v',
      createdBy: 'maya',
      datasetSnapshots: snapshots,
      asof: '2026-02-01T13:29:00Z',
    });
    snapshots.clickhouse = 'snap-99';
    expect(version.datasetSnapshots.clickhouse).toBe('snap-42');
  });
});

describe('templates (PRD 3.9)', () => {
  it('keeps the structure and drops the instrument bindings', () => {
    const canvas = built();
    const template = stripInstrumentBindings(canvas);

    // Same graph, same methods.
    expect(template.nodeCount).toBe(canvas.nodeCount);
    expect(template.edgeCount).toBe(canvas.edgeCount);
    expect(template.getNode('scenario')?.params.shockBps).toBe(50);
    expect(template.getNode('nvda')?.params.label).toBe('Semis anchor');

    // No longer about one name.
    expect(template.getNode('nvda')?.params.ticker).toBeNull();
    // And the original is untouched.
    expect(canvas.getNode('nvda')?.params.ticker).toBe('NVDA');
  });

  it('takes the caller\u2019s list of what counts as a binding', () => {
    const canvas = new SyncedCanvas();
    canvas.addNode(node('n', { params: { desk: 'macro', ticker: 'NVDA' } }));
    const template = stripInstrumentBindings(canvas, ['desk']);
    expect(template.getNode('n')?.params.desk).toBeNull();
    expect(template.getNode('n')?.params.ticker).toBe('NVDA');
  });
});
