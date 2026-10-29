import { describe, expect, it } from 'vitest';
import { BitemporalStore } from '../src/bitemporal.js';
import { localSource, type PointInTimeSource } from '../src/factTile.js';
import { createUniverseNode, UnknownField } from '../src/screener.js';
import { evaluateUniverseNode, type InstrumentReference } from '../src/universeSource.js';

const THE_MORNING = '2024-08-05T09:30:00Z';
const TODAY = () => '2026-09-10T00:00:00Z';
const pinned = { mode: 'pinned' as const, asof: THE_MORNING };
const live = { mode: 'live' as const };
const CATALOG = ['market_cap', 'short_interest'];

const reference: InstrumentReference[] = [
  { instrument: 'NVDA', listed: '1999-01-22', fields: { sector: 'semis' } },
  { instrument: 'AMD', listed: '1979-03-17', fields: { sector: 'semis' } },
  { instrument: 'WOLF', listed: '1993-02-01', delisted: '2025-07-01', fields: { sector: 'semis' } },
  { instrument: 'ARM', listed: '2023-09-14', fields: { sector: 'semis' } },
  { instrument: 'NEWCO', listed: '2025-05-01', fields: { sector: 'semis' } },
  { instrument: 'XOM', listed: '1920-01-01', fields: { sector: 'energy' } },
];

function store() {
  const s = new BitemporalStore<number>();
  s.appendAll([
    // Known on the morning, then moved.
    { key: 'NVDA.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 2.6e12 },
    { key: 'NVDA.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 4.1e12 },
    { key: 'AMD.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 2.2e11 },
    { key: 'AMD.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 3.9e11 },
    { key: 'WOLF.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 1.1e9 },
    { key: 'ARM.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 1.2e11 },
    { key: 'NEWCO.market_cap', validTime: '2026-09-09', knowledgeTime: '2026-09-09', value: 5e11 },
    { key: 'XOM.market_cap', validTime: '2024-08-02', knowledgeTime: '2024-08-02', value: 5.1e11 },
    // A short-interest figure restated after the morning.
    { key: 'AMD.short_interest', validTime: '2024-07-31', knowledgeTime: '2024-08-01', value: 0.04 },
    { key: 'AMD.short_interest', validTime: '2024-07-31', knowledgeTime: '2024-09-15', value: 0.06, restatement: true },
  ]);
  return s;
}

/** Counts reads, and withholds the keys named. */
function counting(base: PointInTimeSource, withhold: (key: string, validTime: string) => boolean = () => false) {
  const reads: string[] = [];
  const source: PointInTimeSource = {
    name: base.name,
    read: async (query) => {
      reads.push(query.key);
      const r = await base.read(query);
      return {
        observations: r.observations.filter((o) => !withhold(query.key, o.validTime)),
        blocked: [
          ...r.blocked,
          ...r.observations.filter((o) => withhold(query.key, o.validTime)).map((o) => ({ validTime: o.validTime, message: 'Requires a vendor-b licence.' })),
        ],
      };
    },
  };
  return { reads, source };
}

describe('a universe on a scrubbed canvas', () => {
  it('screens what was known that morning, and what is known today', async () => {
    const node = createUniverseNode('u', 'sector == "semis" and market_cap > 100b');
    const morning = await evaluateUniverseNode(node, localSource(store()), reference, CATALOG, pinned, TODAY);
    expect(morning).toMatchObject({ kind: 'universe', source: 'local store' });
    if (morning.kind !== 'universe') throw new Error('unreachable');
    // WOLF was trading and too small; NEWCO had not listed.
    expect(morning.universe.members).toEqual(['AMD', 'ARM', 'NVDA']);
    expect(morning.universe.eligible).toBe(5);
    expect(morning.universe.asof).toBe(THE_MORNING);
    expect(node.provenance.asof).toBe(THE_MORNING);
    expect(node.state.status).toBe('ready');

    const today = await evaluateUniverseNode(node, localSource(store()), reference, CATALOG, live, TODAY);
    if (today.kind !== 'universe') throw new Error('unreachable');
    // WOLF has delisted; NEWCO has listed and grown; ARM has no figure known since — it stays at the last one.
    expect(today.universe.members).toEqual(['AMD', 'ARM', 'NEWCO', 'NVDA']);
  });

  it('reads the restated figure only after the restatement was known', async () => {
    const node = createUniverseNode('u', 'short_interest > 5%');
    const at = async (asof: string) => {
      const v = await evaluateUniverseNode(node, localSource(store()), reference, CATALOG, { mode: 'pinned', asof }, TODAY);
      return v.kind === 'universe' ? v.universe.members : [];
    };
    expect(await at(THE_MORNING)).toEqual([]);
    expect(await at('2024-09-16T00:00:00Z')).toEqual(['AMD']);
  });

  it('reads only the fields the expression needs, for the names trading on the date', async () => {
    const { reads, source } = counting(localSource(store()));
    await evaluateUniverseNode(createUniverseNode('u', 'sector == "semis" and market_cap > 100b'), source, reference, CATALOG, pinned, TODAY);
    expect(reads.sort()).toEqual(['AMD.market_cap', 'ARM.market_cap', 'NVDA.market_cap', 'WOLF.market_cap', 'XOM.market_cap']);
  });

  it('refuses a field outside the catalog before reading anything', async () => {
    const { reads, source } = counting(localSource(store()));
    await expect(
      evaluateUniverseNode(createUniverseNode('u', 'markte_cap > 10b'), source, reference, CATALOG, pinned, TODAY),
    ).rejects.toThrow(UnknownField);
    await expect(
      evaluateUniverseNode(createUniverseNode('u', 'markte_cap > 10b'), source, reference, CATALOG, pinned, TODAY),
    ).rejects.toThrow(/did you mean "market_cap"/);
    expect(reads).toEqual([]);
  });

  it('counts a catalogued field with no value on the date as missing data, not an unknown field', async () => {
    const v = await evaluateUniverseNode(createUniverseNode('u', 'short_interest > 1%'), localSource(store()), reference, CATALOG, pinned, TODAY);
    if (v.kind !== 'universe') throw new Error('unreachable');
    expect(v.universe.members).toEqual(['AMD']);
    expect(v.universe.undecided).toEqual({ count: 4, byField: { short_interest: 4 } });
    expect(v.universe.withheld.count).toBe(0);
  });

  it('reports a withheld field as withheld, and never screens on the older period', async () => {
    // NVDA's latest market cap is withheld from this reader; the older one is not.
    const { source } = counting(localSource(store()), (key, validTime) => key === 'NVDA.market_cap' && validTime === '2026-09-09');
    const v = await evaluateUniverseNode(createUniverseNode('u', 'market_cap > 100b'), source, reference, CATALOG, live, TODAY);
    if (v.kind !== 'universe') throw new Error('unreachable');
    expect(v.universe.members).not.toContain('NVDA');
    expect(v.universe.withheld).toEqual({ count: 1, byField: { market_cap: 1 } });
    expect(v.universe.undecided.count).toBe(0);
    // Withheld or not, a name decided by another clause is decided.
    const either = await evaluateUniverseNode(createUniverseNode('u', 'market_cap > 100b or sector == "semis"'), source, reference, CATALOG, live, TODAY);
    if (either.kind !== 'universe') throw new Error('unreachable');
    expect(either.universe.members).toContain('NVDA');
    expect(either.universe.withheld.count).toBe(0);
  });

  it('discards a screen that lands after the canvas moved', async () => {
    const node = createUniverseNode('u', 'market_cap > 100b');
    const slow: PointInTimeSource = {
      name: 'slow',
      read: async (query) => {
        node.provenance = { ...node.provenance, asof: '2026-01-01T00:00:00Z' };
        return localSource(store()).read(query);
      },
    };
    expect(await evaluateUniverseNode(node, slow, reference, CATALOG, pinned, TODAY)).toEqual({ kind: 'superseded', asof: THE_MORNING });
  });
});
