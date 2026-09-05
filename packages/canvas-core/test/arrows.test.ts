import { describe, expect, it } from 'vitest';
import { promoteAnnotationToData, resolveDrawnArrow } from '../src/arrows.js';
import type { Edge } from '../src/types.js';
import { node, port } from './fixtures.js';

describe('drawn arrows (PRD 3.2.2)', () => {
  it('loose to loose is a pure drawing', () => {
    const a = node({ binding: 'loose' });
    const b = node({ binding: 'loose' });
    const res = resolveDrawnArrow(a, b);
    expect(res.class).toBe('annotation');
    expect(res.promotable).toBeUndefined();
    expect(res.reason).toBeUndefined();
  });

  it('wired to wired with compatible ports stays an annotation but offers promotion', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ inputs: [port('in', 'scalar')] });
    const res = resolveDrawnArrow(a, b);
    // Never silently converted: the class is still annotation.
    expect(res.class).toBe('annotation');
    expect(res.promotable).toEqual({
      from: { nodeId: a.id, portId: 'out' },
      to: { nodeId: b.id, portId: 'in' },
      adapter: 'latest',
    });
  });

  it('prefers a required input when several ports would accept the wire', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({
      inputs: [
        port('optional', 'series', { required: false }),
        port('primary', 'series', { required: true }),
      ],
    });
    expect(resolveDrawnArrow(a, b).promotable?.to.portId).toBe('primary');
  });

  it('wired to wired with incompatible types gives an inline reason and a fix', () => {
    const a = node({ outputs: [port('out', 'series', { emits: { frequency: 'daily' } })] });
    const b = node({
      inputs: [port('in', 'series', { constraints: { frequency: ['intraday'] } })],
    });
    const res = resolveDrawnArrow(a, b);
    expect(res.class).toBe('annotation');
    expect(res.promotable).toBeUndefined();
    expect(res.reason).toContain('series(daily)');
    expect(res.fix?.kind).toBe('insert_node');
  });

  it('causal mode wins over everything and prompts for sign, lag and elasticity', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ inputs: [port('in', 'series')] });
    const res = resolveDrawnArrow(a, b, { causalMode: true });
    expect(res.class).toBe('causal');
    expect(res.needsCausalParams).toBe(true);
    expect(res.promotable).toBeUndefined();
  });

  it('loose to wired attaches the note as analyst context, not as data', () => {
    const sticky = node({ binding: 'loose', kind: 'TextPad' });
    const options = node({ kind: 'StrategyNode', inputs: [port('in', 'text')] });
    const res = resolveDrawnArrow(sticky, options);
    expect(res.class).toBe('reference');
    expect(res.contextTag).toBe('analyst_note');
    expect(res.promotable).toBeUndefined();
  });

  it('wired to loose is a drawing, and a bound endpoint exposes no ports', () => {
    const chart = node({ outputs: [port('out', 'series')] });
    const sticky = node({ binding: 'loose' });
    expect(resolveDrawnArrow(chart, sticky).class).toBe('annotation');

    const bound = node({ binding: 'bound', inputs: [port('in', 'series')] });
    const res = resolveDrawnArrow(chart, bound);
    expect(res.class).toBe('annotation');
    expect(res.promotable).toBeUndefined();
  });

  it('promotes an annotation to a data edge only when asked', () => {
    const a = node({ outputs: [port('out', 'series')] });
    const b = node({ inputs: [port('in', 'scalar')] });
    const res = resolveDrawnArrow(a, b);
    if (!res.promotable) throw new Error('expected a promotable arrow');

    const drawn: Edge = {
      id: 'e1',
      from: { nodeId: a.id, portId: '' },
      to: { nodeId: b.id, portId: '' },
      class: 'annotation',
    };
    const wired = promoteAnnotationToData(drawn, res.promotable);
    expect(wired.class).toBe('data');
    expect(wired.adapter).toBe('latest');
    expect(wired.to.portId).toBe('in');
    // The original drawing is untouched.
    expect(drawn.class).toBe('annotation');
  });
});
