import { describe, expect, it } from 'vitest';
import { addNode, connect, createDocument, createNode, type PicassoNode } from '@picasso/canvas-core';
import {
  HOURS_PER_YEAR,
  basis,
  chainMetricNode,
  fundingBasisNode,
  protocolRevenueNode,
  tokenUnlockNode,
  unlockSchedule,
  type VestingTranche,
} from '../src/chain.js';

/**
 * A regression node that takes two quarterly series. Nothing about it knows
 * what a blockchain is, which is the point of the test.
 */
function regressionNode(id: string): PicassoNode {
  return createNode({
    id,
    kind: 'TransformNode',
    binding: 'wired',
    inputs: [
      {
        id: 'y',
        name: 'dependent',
        type: 'series',
        cardinality: 'one',
        required: true,
        constraints: { frequency: ['quarterly'], minHistory: 8 },
      },
      {
        id: 'x',
        name: 'regressor',
        type: 'series',
        cardinality: 'one',
        required: true,
        constraints: { frequency: ['quarterly', 'monthly'], minHistory: 8 },
      },
    ],
    outputs: [{ id: 'out', name: 'fit', type: 'table', cardinality: 'one', required: false }],
  });
}

function fundamentalNode(id: string): PicassoNode {
  return createNode({
    id,
    kind: 'DataTile',
    binding: 'wired',
    outputs: [
      {
        id: 'out',
        name: 'segment gross margin',
        type: 'series',
        cardinality: 'one',
        required: false,
        emits: { frequency: 'quarterly', history: 24, assetClass: 'equity' },
      },
    ],
  });
}

describe("the section's own claim about types", () => {
  // "normalized into the same `series` type as everything else, which is the
  // point: a crypto on-chain series and an equity fundamental series wire into
  // the same regression node."
  //
  // Checked through canvas-core's real connect, not asserted in prose. If the
  // claim were false the connection would be rejected here.
  it('wires an on-chain series and an equity fundamental into the same node', () => {
    const doc = createDocument('canvas-1');
    addNode(doc, regressionNode('reg'));
    addNode(doc, fundamentalNode('gm'));
    addNode(
      doc,
      chainMetricNode({
        id: 'flows',
        chainId: 1,
        metric: 'exchange_inflow',
        frequency: 'quarterly',
        history: 16,
      }),
    );

    const equity = connect(doc, {
      id: 'e1',
      from: { nodeId: 'gm', portId: 'out' },
      to: { nodeId: 'reg', portId: 'y' },
    });
    const chain = connect(doc, {
      id: 'e2',
      from: { nodeId: 'flows', portId: 'out' },
      to: { nodeId: 'reg', portId: 'x' },
    });

    expect(equity.ok).toBe(true);
    expect(chain.ok).toBe(true);
  });

  // The one place crypto genuinely differs is frequency: on-chain metrics are
  // per-block and fundamentals are quarterly. canvas-core does not paper over
  // that — it rejects and names the fix, because aggregating daily gas prices
  // to a quarter is a choice between mean, last and sum that nobody else can
  // make for the analyst. The node's job is to declare its real frequency and
  // let that rejection happen.
  it('declares its real frequency and gets a named resample fix, not a silent one', () => {
    const doc = createDocument('canvas-2');
    addNode(doc, regressionNode('reg'));
    addNode(
      doc,
      chainMetricNode({ id: 'gas', chainId: 1, metric: 'gas_price', frequency: 'daily', history: 900 }),
    );
    const result = connect(doc, {
      id: 'e1',
      from: { nodeId: 'gas', portId: 'out' },
      to: { nodeId: 'reg', portId: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.code).toBe('frequency_mismatch');
      expect(result.rejection.fix).toMatchObject({ op: 'resample', to: 'quarterly' });
    }
  });

  // The same rule, one lattice over: a token-denominated revenue series into a
  // USD-constrained port is refused and told what conversion it needs.
  it('refuses a denomination mismatch and names the conversion', () => {
    const doc = createDocument('canvas-4');
    addNode(
      doc,
      createNode({
        id: 'ratio',
        kind: 'TransformNode',
        binding: 'wired',
        inputs: [
          {
            id: 'rev',
            name: 'revenue',
            type: 'series',
            cardinality: 'one',
            required: true,
            constraints: { currency: 'USD' },
          },
        ],
        outputs: [{ id: 'out', name: 'ratio', type: 'series', cardinality: 'one', required: false }],
      }),
    );
    addNode(
      doc,
      protocolRevenueNode({ id: 'rev', protocol: 'uniswap', currency: 'UNI', frequency: 'daily' }),
    );
    const result = connect(doc, {
      id: 'e1',
      from: { nodeId: 'rev', portId: 'out' },
      to: { nodeId: 'ratio', portId: 'rev' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.code).toBe('currency_mismatch');
      expect(result.rejection.fix).toMatchObject({ op: 'convert_currency', to: 'USD' });
    }
  });

  it('still fails an honest constraint rather than passing everything', () => {
    const doc = createDocument('canvas-3');
    addNode(doc, regressionNode('reg'));
    addNode(
      doc,
      chainMetricNode({ id: 'short', chainId: 1, metric: 'active_addresses', frequency: 'quarterly', history: 3 }),
    );
    const result = connect(doc, {
      id: 'e1',
      from: { nodeId: 'short', portId: 'out' },
      to: { nodeId: 'reg', portId: 'x' },
    });
    expect(result.ok).toBe(false);
  });

  // Protocol revenue quoted in the protocol's own token moves when the token
  // moves, which makes every ratio built on it circular. A currency-stamped
  // port is what lets the lattice insert a conversion instead of letting two
  // denominations meet silently.
  it('stamps protocol revenue with a real currency', () => {
    const node = protocolRevenueNode({
      id: 'rev',
      protocol: 'uniswap',
      currency: 'USD',
      frequency: 'daily',
      history: 400,
    });
    expect(node.outputs[0]?.emits?.currency).toBe('USD');
  });
});

describe('funding and basis', () => {
  // An eight-hour venue pays three times a day and a one-hour venue pays
  // twenty-four, so comparing raw funding rates across venues compares
  // different things.
  it('annualizes funding on the venue\'s own schedule', () => {
    const eightHourly = basis({
      venue: 'a',
      perp: 101,
      spot: 100,
      fundingRate: 0.0001,
      fundingIntervalHours: 8,
    });
    const hourly = basis({
      venue: 'b',
      perp: 101,
      spot: 100,
      fundingRate: 0.0001,
      fundingIntervalHours: 1,
    });
    expect(eightHourly.fundingAnnualized).toBeCloseTo(0.0001 * (HOURS_PER_YEAR / 8), 10);
    expect(hourly.fundingAnnualized).toBeCloseTo(eightHourly.fundingAnnualized * 8, 10);
  });

  it('reports carry as the annualized basis net of annualized funding', () => {
    const reading = basis({
      venue: 'a',
      perp: 101,
      spot: 100,
      fundingRate: 0.0001,
      fundingIntervalHours: 8,
    });
    expect(reading.basis).toBeCloseTo(0.01, 12);
    expect(reading.carry).toBeCloseTo(0.01 - reading.fundingAnnualized, 12);
  });

  it('does not divide by a missing spot', () => {
    expect(basis({ venue: 'a', perp: 101, spot: 0, fundingRate: 0, fundingIntervalHours: 8 }).basis).toBeNaN();
  });

  it('emits carry as an ordinary series port', () => {
    const node = fundingBasisNode({ id: 'fb', instrument: 'BTC-PERP', venue: 'a', frequency: 'daily' });
    expect(node.outputs[0]?.type).toBe('series');
  });
});

describe('token unlocks', () => {
  const tranches: VestingTranche[] = [
    { at: '2026-07-01', tokens: 10_000_000, recipient: 'team' },
    { at: '2026-04-01', tokens: 4_000_000, recipient: 'investors' },
  ];

  it('are dated events, in date order', () => {
    const events = unlockSchedule(tranches, () => 40_000_000);
    expect(events.map((e) => e.at)).toEqual(['2026-04-01', '2026-07-01']);
  });

  // Ten million tokens is not a fact about anything until it is ten million
  // against a float of forty.
  it('report the share of float, which is the number that means something', () => {
    const events = unlockSchedule(tranches, () => 40_000_000);
    expect(events[1]?.shareOfFloat).toBeCloseTo(0.25, 12);
  });

  it('report days of volume when a volume series is available', () => {
    const events = unlockSchedule(tranches, () => 40_000_000, () => 2_000_000);
    expect(events[1]?.daysOfVolume).toBe(5);
    expect(unlockSchedule(tranches, () => 40_000_000)[1]?.daysOfVolume).toBeUndefined();
  });

  // Emitting this as a daily series of mostly zeros would let it wire into a
  // regression node, and regressing returns on a column of zeros with four
  // spikes is a way to get a confident coefficient out of four observations.
  it('emit an event port, not a series port', () => {
    const node = tokenUnlockNode({ id: 'unlocks', token: 'ARB', tranches });
    expect(node.outputs[0]?.type).toBe('event');
    expect(node.outputs[0]?.cardinality).toBe('many');
  });

  it('do not divide by a zero float', () => {
    expect(unlockSchedule(tranches, () => 0)[0]?.shareOfFloat).toBeNaN();
  });
});
