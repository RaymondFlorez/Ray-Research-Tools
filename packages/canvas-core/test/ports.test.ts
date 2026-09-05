import { describe, expect, it } from 'vitest';
import { compatibleInputPorts, implicitAdapter, validateConnection } from '../src/ports.js';
import { node, port } from './fixtures.js';

describe('port type system (PRD 3.4.5)', () => {
  it('accepts an exact type match with no adapter', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ inputs: [port('in', 'series')] });
    const result = validateConnection(a, 'out', b, 'in');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBeUndefined();
      expect(result.warnings).toEqual([]);
    }
  });

  it('inserts an implicit latest() adapter wiring series into a scalar port', () => {
    expect(implicitAdapter('series', 'scalar')).toBe('latest');
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ inputs: [port('in', 'scalar')] });
    const result = validateConnection(a, 'out', b, 'in');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBe('latest');
      expect(result.warnings[0]).toMatch(/latest\(\)/);
    }
  });

  it('does not coerce in the other direction', () => {
    const a = node({ outputs: [port('out', 'scalar')] });
    const b = node({ inputs: [port('in', 'series')] });
    const result = validateConnection(a, 'out', b, 'in');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('type_mismatch');
  });

  it('rejects series(daily) into a port constrained to intraday, with a resample fix', () => {
    const a = node({ outputs: [port('out', 'series', { emits: { frequency: 'daily' } })] });
    const b = node({
      inputs: [port('in', 'series', { constraints: { frequency: ['intraday'] } })],
    });
    const result = validateConnection(a, 'out', b, 'in');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('frequency_mismatch');
      expect(result.message).toContain('series(daily)');
      expect(result.fix).toEqual({
        kind: 'insert_node',
        nodeKind: 'TransformNode',
        op: 'resample',
        to: 'intraday',
        label: 'Upsample to intraday',
      });
    }
  });

  it('rejects a currency mismatch with a conversion fix', () => {
    const a = node({ outputs: [port('out', 'series', { emits: { currency: 'EUR' } })] });
    const b = node({ inputs: [port('in', 'series', { constraints: { currency: 'USD' } })] });
    const result = validateConnection(a, 'out', b, 'in');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('currency_mismatch');
      expect(result.fix?.kind).toBe('insert_node');
    }
  });

  it('rejects insufficient history and asset-class mismatches', () => {
    const short = node({ outputs: [port('out', 'series', { emits: { history: 20 } })] });
    const needsHistory = node({
      inputs: [port('in', 'series', { constraints: { minHistory: 250 } })],
    });
    const historyResult = validateConnection(short, 'out', needsHistory, 'in');
    expect(historyResult.ok).toBe(false);
    if (!historyResult.ok) expect(historyResult.code).toBe('insufficient_history');

    const crypto = node({ outputs: [port('out', 'series', { emits: { assetClass: 'crypto' } })] });
    const equityOnly = node({
      inputs: [port('in', 'series', { constraints: { assetClass: ['equity'] } })],
    });
    const classResult = validateConnection(crypto, 'out', equityOnly, 'in');
    expect(classResult.ok).toBe(false);
    if (!classResult.ok) expect(classResult.code).toBe('asset_class_mismatch');
  });

  it('refuses to wire a node that is not wired, and offers promotion', () => {
    const sketch = node({ binding: 'loose', outputs: [port('out', 'series')] });
    const target = node({ inputs: [port('in', 'series')] });
    const result = validateConnection(sketch, 'out', target, 'in');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_wired');
      expect(result.fix).toEqual({
        kind: 'promote',
        nodeId: sketch.id,
        to: 'wired',
        label: 'Promote to wired',
      });
    }
  });

  it('enforces cardinality one and rejects duplicate edges', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ outputs: [port('out', 'series')] });
    const target = node({ inputs: [port('in', 'series', { cardinality: 'one' })] });
    const existing = [
      {
        id: 'e1',
        from: { nodeId: a.id, portId: 'out' },
        to: { nodeId: target.id, portId: 'in' },
        class: 'data' as const,
      },
    ];

    const occupied = validateConnection(b, 'out', target, 'in', { edges: existing });
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.code).toBe('port_occupied');

    const duplicate = validateConnection(a, 'out', target, 'in', { edges: existing });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe('duplicate_edge');
  });

  it('allows many-cardinality ports to take several inputs', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ outputs: [port('out', 'series')] });
    const target = node({ inputs: [port('in', 'series', { cardinality: 'many' })] });
    const existing = [
      {
        id: 'e1',
        from: { nodeId: a.id, portId: 'out' },
        to: { nodeId: target.id, portId: 'in' },
        class: 'data' as const,
      },
    ];
    expect(validateConnection(b, 'out', target, 'in', { edges: existing }).ok).toBe(true);
  });

  it('blocks an unverified model output from feeding a compute node (PRD 4.5)', () => {
    const modelOutput = node({
      kind: 'QueryNode',
      verified: false,
      outputs: [port('out', 'scalar')],
    });
    const sim = node({ kind: 'MonteCarloNode', inputs: [port('in', 'scalar')] });
    const blocked = validateConnection(modelOutput, 'out', sim, 'in');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('unverified_input');
      expect(blocked.fix?.kind).toBe('override_unverified');
    }

    const overridden = validateConnection(modelOutput, 'out', sim, 'in', {
      hasUnverifiedOverride: true,
    });
    expect(overridden.ok).toBe(true);
  });

  it('lets an unverified output feed a display node without an override', () => {
    const modelOutput = node({ verified: false, outputs: [port('out', 'text')] });
    const pad = node({ kind: 'TextPad', inputs: [port('in', 'text')] });
    expect(validateConnection(modelOutput, 'out', pad, 'in').ok).toBe(true);
  });

  it('refuses a self loop and honours the cycle predicate', () => {
    const a = node({ inputs: [port('in', 'series')], outputs: [port('out', 'series')] });
    const self = validateConnection(a, 'out', a, 'in');
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe('self_loop');

    const b = node({ inputs: [port('in', 'series')] });
    const cyclic = validateConnection(a, 'out', b, 'in', { wouldCreateCycle: () => true });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.code).toBe('cycle');
  });

  it('lists only the input ports a drag could legally land on', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const target = node({
      inputs: [port('ok', 'series'), port('also', 'scalar'), port('no', 'portfolio')],
    });
    expect(compatibleInputPorts(a, 'out', target).map((p) => p.id)).toEqual(['ok', 'also']);
  });
});
