import { describe, expect, it } from 'vitest';
import { SyncedCanvas } from '../src/canvas.js';
import { Link, Room, catchUp } from '../src/transport.js';
import { edge, inkPoint, node, structure } from './helpers.js';

function pair(): { a: SyncedCanvas; b: SyncedCanvas; link: Link } {
  const a = new SyncedCanvas({ id: 'semis' });
  const b = new SyncedCanvas();
  return { a, b, link: new Link(a.doc, b.doc) };
}

describe('convergence', () => {
  it('two editors working at once end up with the same document', () => {
    const { a, b } = pair();

    a.addNode(node('nvda', { position: { x: 100, y: 100 } }));
    b.addNode(node('avgo', { position: { x: 400, y: 100 } }));
    a.addNode(node('scenario', { kind: 'ScenarioNode', position: { x: 250, y: 400 } }));
    b.addEdge(edge('e1', 'nvda', 'scenario'));
    a.addEdge(edge('e2', 'avgo', 'scenario'));

    expect(structure(a)).toBe(structure(b));
    expect(a.nodeCount).toBe(3);
    expect(a.edgeCount).toBe(2);
  });

  it('keeps both edits when two people change different fields of one node', () => {
    const { a, b } = pair();
    a.addNode(node('nvda', { params: { ticker: 'NVDA' } }));

    // One analyst moves it, the other renames it, at the same time.
    a.moveNode('nvda', { x: 900, y: 250 });
    b.setParam('nvda', 'label', 'Semis anchor');

    expect(structure(a)).toBe(structure(b));
    const merged = a.getNode('nvda');
    expect(merged?.position).toEqual({ x: 900, y: 250 });
    expect(merged?.params.label).toBe('Semis anchor');
    expect(merged?.params.ticker).toBe('NVDA');
  });

  it('keeps both params when two people set different keys on one node', () => {
    const { a, b } = pair();
    a.addNode(node('sim', { kind: 'MonteCarloNode' }));

    a.setParam('sim', 'paths', 100_000);
    b.setParam('sim', 'process', 'heston');

    expect(a.getNode('sim')?.params).toEqual({ paths: 100_000, process: 'heston' });
    expect(structure(a)).toBe(structure(b));
  });

  it('removes a node and its edges atomically, so no peer sees a dangling edge', () => {
    const { a, b } = pair();
    a.addNode(node('src'));
    a.addNode(node('sink'));
    a.addEdge(edge('e1', 'src', 'sink'));

    const seen: number[] = [];
    b.observe(() => {
      const doc = b.snapshot();
      // Count edges whose endpoints are missing at the moment of every change.
      const dangling = [...doc.edges.values()].filter(
        (e) => !doc.nodes.has(e.from.nodeId) || !doc.nodes.has(e.to.nodeId),
      ).length;
      seen.push(dangling);
    });

    a.removeNode('src');
    expect(seen.every((count) => count === 0)).toBe(true);
    expect(b.edgeCount).toBe(0);
  });
});

describe('offline editing (PRD 7.4, step 5)', () => {
  it('both sides keep working while the link is down and merge on reconnect', () => {
    const { a, b, link } = pair();
    a.addNode(node('shared'));
    expect(b.nodeCount).toBe(1);

    link.disconnect();

    // Each analyst keeps working, seeing none of the other's edits.
    a.addNode(node('a-only', { position: { x: 10, y: 10 } }));
    a.setParam('shared', 'note', 'from a');
    b.addNode(node('b-only', { position: { x: 20, y: 20 } }));
    b.setParam('shared', 'other', 'from b');

    expect(a.nodeCount).toBe(2);
    expect(b.nodeCount).toBe(2);
    expect(a.getNode('b-only')).toBeUndefined();

    link.connect();

    expect(a.nodeCount).toBe(3);
    expect(b.nodeCount).toBe(3);
    expect(structure(a)).toBe(structure(b));
    expect(a.getNode('shared')?.params).toEqual({ note: 'from a', other: 'from b' });
  });

  it('needs no queue: a fresh peer catches up from a state vector alone', () => {
    const a = new SyncedCanvas();
    a.addNode(node('one'));
    a.addNode(node('two'));
    a.addEdge(edge('e1', 'one', 'two'));

    // A peer that has never seen this document at all.
    const late = new SyncedCanvas();
    catchUp(a.doc, late.doc);
    expect(structure(late)).toBe(structure(a));
  });

  it('a peer that edited offline for a long time still converges', () => {
    const { a, b, link } = pair();
    a.addNode(node('base'));
    link.disconnect();

    for (let i = 0; i < 50; i++) a.addNode(node(`a${i}`, { position: { x: i, y: 0 } }));
    for (let i = 0; i < 50; i++) b.addNode(node(`b${i}`, { position: { x: 0, y: i } }));

    link.connect();
    expect(a.nodeCount).toBe(101);
    expect(structure(a)).toBe(structure(b));
  });
});

describe('ink (PRD 3.7)', () => {
  it('interleaves appends from two clients without losing a run', () => {
    const { a, b } = pair();
    a.addStroke({ id: 's1', runs: [] });
    b.addStroke({ id: 's2', runs: [] });

    // Two people drawing at the same time, on their own strokes.
    for (let i = 0; i < 20; i++) {
      a.appendRun('s1', { points: [inkPoint(i, 0, i)] });
      b.appendRun('s2', { points: [inkPoint(0, i, i)] });
    }

    expect(structure(a)).toBe(structure(b));
    expect(a.getStroke('s1')?.runs).toHaveLength(20);
    expect(a.getStroke('s2')?.runs).toHaveLength(20);
  });

  it('keeps every run when two clients append to the same stroke', () => {
    const { a, b } = pair();
    a.addStroke({ id: 'shared', runs: [] });

    for (let i = 0; i < 10; i++) {
      a.appendRun('shared', { points: [inkPoint(i, 0, i)] });
      b.appendRun('shared', { points: [inkPoint(i, 100, i)] });
    }

    // Append-only means nothing is overwritten: every run survives.
    expect(a.getStroke('shared')?.runs).toHaveLength(20);
    expect(structure(a)).toBe(structure(b));
  });

  it('commits a stroke down to its simplified run', () => {
    const { a, b } = pair();
    a.addStroke({ id: 's1', runs: [] });
    for (let i = 0; i < 50; i++) a.appendRun('s1', { points: [inkPoint(i, 0, i)] });
    expect(a.getStroke('s1')?.runs).toHaveLength(50);

    a.commitStroke('s1', [inkPoint(0, 0, 0), inkPoint(49, 0, 49)]);

    expect(a.getStroke('s1')?.runs).toHaveLength(1);
    expect(a.getStroke('s1')?.committed).toBe(true);
    expect(b.getStroke('s1')?.runs[0]?.points).toHaveLength(2);
    expect(structure(a)).toBe(structure(b));
  });
});

describe('the document syncs, the computation does not', () => {
  it('does not carry runtime state to other clients', () => {
    const { a, b } = pair();
    const ready = node('nvda');
    ready.state = { status: 'ready', cacheKey: 'abc', latencyMs: 42, costCents: 3 };
    a.addNode(ready);

    // The peer has not computed this node, so it arrives stale, not ready.
    const remote = b.getNode('nvda');
    expect(remote?.state.status).toBe('stale');
    expect(remote?.state.cacheKey).toBeUndefined();
    expect(remote?.state.costCents).toBeUndefined();
  });

  it('brings loose objects across as idle, since they never schedule', () => {
    const { a, b } = pair();
    a.addNode(node('sketch', { kind: 'InkLayer', binding: 'loose' }));
    expect(b.getNode('sketch')?.state.status).toBe('idle');
  });

  it('carries provenance, which is a fact about the canvas', () => {
    const { a, b } = pair();
    const withProvenance = node('tile', { kind: 'DataTile' });
    withProvenance.provenance = {
      datasetSnapshots: { clickhouse: 'snap-42' },
      asof: '2026-02-01T21:00:00Z',
      verified: false,
    };
    a.addNode(withProvenance);

    expect(b.getNode('tile')?.provenance).toEqual({
      datasetSnapshots: { clickhouse: 'snap-42' },
      asof: '2026-02-01T21:00:00Z',
      verified: false,
    });
  });
});

describe('undo (PRD 3.2.6, guardrail #1)', () => {
  it('takes back your own work and leaves your colleague’s alone', () => {
    const { a, b } = pair();
    a.addNode(node('mine'));
    b.addNode(node('theirs'));

    a.undo.undo();

    expect(a.getNode('mine')).toBeUndefined();
    expect(a.getNode('theirs')).toBeDefined();
    expect(structure(a)).toBe(structure(b));
  });

  it('treats one transaction as one undo step', () => {
    const { a } = pair();
    a.addNode(node('src'));
    a.addNode(node('sink'));
    a.addEdge(edge('e1', 'src', 'sink'));

    // Deleting a node takes its edges with it, so undo brings both back.
    a.removeNode('src');
    expect(a.nodeCount).toBe(1);
    expect(a.edgeCount).toBe(0);

    a.undo.undo();
    expect(a.nodeCount).toBe(2);
    expect(a.edgeCount).toBe(1);
  });
});

describe('a room of editors (PRD 7.3: 12 concurrent)', () => {
  it('converges with twelve people editing at once', () => {
    const room = new Room();
    const peers = Array.from({ length: 12 }, () => new SyncedCanvas());
    for (const peer of peers) room.join(peer.doc);

    peers.forEach((peer, i) => {
      peer.addNode(node(`n${i}`, { position: { x: i * 100, y: 0 } }));
      peer.setParam(`n${i}`, 'owner', `analyst-${i}`);
    });
    // Everyone also edits a node somebody else created.
    peers.forEach((peer, i) => {
      peer.setParam(`n${(i + 1) % peers.length}`, 'reviewedBy', `analyst-${i}`);
    });

    const reference = structure(peers[0] as SyncedCanvas);
    for (const peer of peers) {
      expect(peer.nodeCount).toBe(12);
      expect(structure(peer)).toBe(reference);
    }
    room.destroy();
  });

  it('lets a peer drop out, keep working, and rejoin', () => {
    const room = new Room();
    const [a, b, c] = [new SyncedCanvas(), new SyncedCanvas(), new SyncedCanvas()];
    for (const peer of [a, b, c]) room.join(peer.doc);

    a.addNode(node('shared'));
    room.setOnline(c.doc, false);

    a.addNode(node('while-c-away'));
    c.addNode(node('c-offline'));
    expect(c.getNode('while-c-away')).toBeUndefined();

    room.setOnline(c.doc, true);
    expect(structure(a)).toBe(structure(c));
    expect(structure(b)).toBe(structure(c));
    expect(c.nodeCount).toBe(3);
    room.destroy();
  });
});

describe('conflicting intent', () => {
  it('resolves delete-versus-edit the same way on every peer', () => {
    const { a, b, link } = pair();
    a.addNode(node('contested'));
    link.disconnect();

    a.removeNode('contested');
    b.moveNode('contested', { x: 500, y: 500 });

    link.connect();

    // Whatever the outcome, both peers must agree on it: a canvas where one
    // analyst sees a node another does not is worse than either resolution.
    expect(structure(a)).toBe(structure(b));
    expect(a.getNode('contested')).toBeUndefined();
    expect(b.getNode('contested')).toBeUndefined();
  });

  it('resolves same-field writes the same way on every peer', () => {
    const { a, b, link } = pair();
    a.addNode(node('tile'));
    link.disconnect();

    a.setParam('tile', 'ticker', 'NVDA');
    b.setParam('tile', 'ticker', 'AMD');

    link.connect();
    expect(a.getNode('tile')?.params.ticker).toBe(b.getNode('tile')?.params.ticker);
  });
});
