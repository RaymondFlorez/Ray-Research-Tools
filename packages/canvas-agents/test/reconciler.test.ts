import { describe, expect, it } from 'vitest';
import { baseline } from '../src/redteam.js';
import { patch, reconcile, type Narrative } from '../src/reconciler.js';

function run(mutate: (c: ReturnType<typeof baseline>) => void = () => {}) {
  const c = baseline();
  mutate(c);
  return {
    c,
    result: reconcile({
      narrative: c.narrative,
      facts: c.facts,
      cells: c.cells,
      documents: c.documents,
    }),
  };
}

describe('the clean draft', () => {
  it('passes, and reports how many numbers it checked', () => {
    const { result } = run();
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(7);
  });

  it('lists what the prose waiver excused rather than hiding it', () => {
    const { result } = run();
    expect(result.waived.map((w) => w.text)).toEqual(['10']);
  });
});

describe('the worked example from PRD 7.4', () => {
  it('fails the join and names the cell the number should have come from', () => {
    const { result } = run((c) => {
      const handle = c.narrative.handles.find((h) => h.factId === 'f-vega')!;
      c.narrative.text =
        c.narrative.text.slice(0, handle.start) + '-4,200' + c.narrative.text.slice(handle.end);
    });
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.kind === 'transcription');
    expect(finding?.expected).toBe(-3870);
    expect(finding?.found).toBe(-4200);
  });

  it('hands back the corrected number already rendered', () => {
    const { c, result } = run((x) => {
      const handle = x.narrative.handles.find((h) => h.factId === 'f-vega')!;
      x.narrative.text =
        x.narrative.text.slice(0, handle.start) + '-4,200' + x.narrative.text.slice(handle.end);
    });
    expect(result.corrections[0]?.shouldBe).toBe('-3,870');

    // The mechanical patch is the fallback for a Scribe rerun; either way the
    // patched draft has to pass a second reconcile.
    const fixed: Narrative = patch(c.narrative, result.corrections);
    const second = reconcile({
      narrative: fixed,
      facts: c.facts,
      cells: c.cells,
      documents: c.documents,
    });
    expect(second.ok).toBe(true);
  });
});

describe('the chain each cited number has to hold', () => {
  it('breaks when the fact and the cell disagree', () => {
    const { result } = run((c) => {
      c.cells.find((x) => x.nodeId === 'agg-vega')!.value = -3510;
    });
    expect(result.findings.map((f) => f.kind)).toContain('cell_mismatch');
  });

  it('breaks when the cell has moved past the key the fact was read at', () => {
    const { result } = run((c) => {
      c.cells.find((x) => x.nodeId === 'agg-delta')!.cacheKey = 'k-delta-2';
    });
    expect(result.findings.map((f) => f.kind)).toContain('stale_cell');
  });

  it('breaks when the only provenance is a model dispatch', () => {
    const { result } = run((c) => {
      c.facts.find((f) => f.id === 'f-vega')!.provenance = { kind: 'model', traceId: 't-1' };
    });
    const finding = result.findings.find((f) => f.kind === 'unverified_source');
    expect(finding?.message).toContain('t-1');
  });

  it('breaks when an extracted number is not in the span it cites', () => {
    const { result } = run((c) => {
      c.facts.find((f) => f.id === 'f-hedging')!.value!.number = 41;
      const handle = c.narrative.handles.find((h) => h.factId === 'f-hedging')!;
      c.narrative.text =
        c.narrative.text.slice(0, handle.start) + '41' + c.narrative.text.slice(handle.end);
      handle.end = handle.start + 2;
    });
    expect(result.findings.map((f) => f.kind)).toContain('document_mismatch');
  });

  it('warns rather than blocks when the document was not supplied for checking', () => {
    const c = baseline();
    const result = reconcile({ narrative: c.narrative, facts: c.facts, cells: c.cells });
    expect(result.ok).toBe(true);
    expect(result.findings.map((f) => f.kind)).toEqual(['unchecked_document']);
  });
});

describe('numbers with no source at all', () => {
  it('are the finding, not an unparseable input', () => {
    const { result } = run((c) => {
      c.narrative.text += ' Net notional is 41,200.';
    });
    const finding = result.findings.find((f) => f.kind === 'unsourced');
    expect(finding?.found).toBe(41200);
    expect(result.ok).toBe(false);
  });

  // The waiver is the one door a fabricated number could walk through, so a
  // span declared as prose that also cites a valued fact is itself a finding.
  it('cannot be smuggled through the prose waiver', () => {
    const { result } = run((c) => {
      c.narrative.handles.find((h) => h.factId === 'f-move')!.kind = 'literal';
    });
    expect(result.findings.map((f) => f.kind)).toContain('waiver_abuse');
  });
});

describe('a total that cites its own node but is not the sum of its legs', () => {
  it('fails on the derivation, independently of every other check', () => {
    const { result } = run((c) => {
      c.facts.find((f) => f.id === 'f-vega-semis')!.value!.number = -1200;
      c.cells.find((x) => x.nodeId === 'leg-semis')!.value = -1200;
      const handle = c.narrative.handles.find((h) => h.factId === 'f-vega-semis')!;
      c.narrative.text =
        c.narrative.text.slice(0, handle.start) + '-1,200' + c.narrative.text.slice(handle.end);
      handle.end = handle.start + 6;
    });
    const finding = result.findings.find((f) => f.kind === 'derivation_mismatch');
    expect(finding?.expected).toBe(-3300);
    expect(finding?.found).toBe(-3870);
  });
});
