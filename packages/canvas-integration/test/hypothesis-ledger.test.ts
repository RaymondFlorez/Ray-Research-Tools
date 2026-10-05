/**
 * The tracker seam: canvas-hypothesis's ledger → its HypothesisNode, and →
 * canvas-agents' Critic (PRD 3.5, 7.4).
 *
 * The ledger decides which numbers count toward a claim; the node resolves
 * whatever it is handed; the Critic cites whatever record it is handed. Each is
 * tested alone. What none can check is that they agree — that the node on the
 * canvas shows the status the record scores, and that the Critic's sentence is
 * read from the record rather than from a list someone typed.
 */

import { describe, expect, it } from 'vitest';
import { critique } from '@picasso/canvas-agents';
import { createHypothesisNode, evaluateHypothesis, HypothesisLedger, type Hypothesis } from '@picasso/canvas-hypothesis';
import { DEFAULT_POLICY, modelById } from '@picasso/canvas-router';

const claim = (id: string, observable: string, author = 'maya'): Hypothesis => ({
  id,
  claim: 'data center gross margin compresses below 71% by the next report',
  confidence: 0.7,
  createdAt: '',
  author,
  observables: [
    { id: observable, name: 'data center segment gross margin', direction: 'below', threshold: 71, falsifier: 73, dueBy: '2026-08-20', unit: '%' },
  ],
});

describe('the node on the canvas shows what the record scores', () => {
  it('agrees when fed what the ledger counted, and would not when fed the raw log', () => {
    const ledger = new HypothesisLedger();
    const stored = ledger.state(claim('h1', 'dc-gm'), '2026-02-10');
    ledger.observe({ observableId: 'dc-gm', value: 70.2, observedAt: '2026-08-18', source: 'Q2 10-Q' }, '2026-08-18');
    // A number backdated into the log after the call settled.
    ledger.observe({ observableId: 'dc-gm', value: 74, observedAt: '2026-08-12', source: 'backfill' }, '2026-08-25');

    const node = createHypothesisNode({ id: stored.id, hypothesis: stored });
    const entry = ledger.entry('h1', '2026-09-01')!;
    const fromLedger = evaluateHypothesis(node, entry.counted.map((c) => c.observation), '2026-09-01');
    expect(fromLedger.resolution.status).toBe('supported');
    expect(fromLedger.resolution.status).toBe(entry.resolution.status);

    // `resolve` alone takes the earliest *dated* number, so a node wired to
    // the raw feed would flip on the backfill. The node must read through the
    // ledger, and this is the assertion that says so.
    const raw = ledger.events().flatMap((e) => (e.kind === 'observed' ? [e.observation] : []));
    expect(evaluateHypothesis(node, raw, '2026-09-01').resolution.status).toBe('contradicted');
  });
});

describe('the Critic cites the record, not a list', () => {
  it('"made this call three times, right once", read off the ledger', () => {
    const ledger = new HypothesisLedger();
    ledger.state(claim('a', 'gm-a'), '2026-02-10');
    ledger.state(claim('b', 'gm-b'), '2026-02-10');
    ledger.state(claim('c', 'gm-c'), '2026-02-10');
    // Another analyst's call of the same shape is not Maya's record.
    ledger.state(claim('d', 'gm-d', 'sam'), '2026-02-10');
    ledger.observe({ observableId: 'gm-a', value: 70, observedAt: '2026-08-18' }, '2026-08-18');
    ledger.observe({ observableId: 'gm-b', value: 74, observedAt: '2026-08-18' }, '2026-08-18');
    ledger.observe({ observableId: 'gm-c', value: 75, observedAt: '2026-08-18' }, '2026-08-18');
    ledger.observe({ observableId: 'gm-d', value: 70, observedAt: '2026-08-18' }, '2026-08-18');

    const result = critique({
      thesis: 'margin compression',
      document: { id: 'c', nodes: new Map(), edges: new Map() },
      author: modelById(DEFAULT_POLICY, 'frontier-a')!,
      available: [],
      history: ledger.scored({ author: 'maya', matching: (h) => h.claim.includes('gross margin compresses') }),
    });
    expect(result.baseRate).toMatchObject({ count: 3, right: 1 });
    expect(result.lines).toContain('made margin compression 3 times, right once');
  });
});
