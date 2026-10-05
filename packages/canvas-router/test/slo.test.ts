import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, NoLatencyBudget, latencyBudgetFor, type PolicyEntry } from '../src/policy.js';
import { route, type RoutingFeatures } from '../src/router.js';

function entry(taskClass: PolicyEntry['taskClass']): PolicyEntry {
  return DEFAULT_POLICY.entries.find((e) => e.taskClass === taskClass)!;
}

function asr(overrides: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    taskClass: 'asr',
    inputTokens: 0,
    expectedOutputTokens: 9_000,
    modalities: ['audio'],
    toolsRequired: [],
    rigorFlag: false,
    dataSensitivity: 'public',
    costCeilingCents: 1_000,
    latencyBudgetMs: 0,
    determinismRequired: false,
    priorFailures: [],
    ...overrides,
  };
}

describe('the 4.2 table, row by row', () => {
  it('states each SLO in the unit the table does', () => {
    expect(entry('intent.classify').slo).toEqual({ kind: 'p95', ms: 120 });
    expect(entry('doc.deep_read').slo).toEqual({ kind: 'p95', ms: 25_000 });
    // "0.15x realtime", and n/a.
    expect(entry('asr').slo).toEqual({ kind: 'realtime', factor: 0.15 });
    expect(entry('embed').slo).toEqual({ kind: 'none' });
  });

  it('names the fleet the table names for ASR and embedding', () => {
    expect(entry('asr').primary).toEqual(['whisper-large-v3']);
    expect(entry('asr').fallback).toEqual(['vendor-asr']);
    expect(entry('embed').primary).toEqual(['open-embed']);
  });
});

describe('a realtime SLO', () => {
  it('gives a sixty-minute call nine minutes and a thirty-second clip four and a half seconds', () => {
    expect(latencyBudgetFor(entry('asr'), { audioSeconds: 3_600 })).toBe(540_000);
    expect(latencyBudgetFor(entry('asr'), { audioSeconds: 30 })).toBeCloseTo(4_500, 9);
  });

  it('refuses to budget an ASR job whose length it does not know', () => {
    // A budget invented from a typical call is wrong for every other call.
    expect(() => latencyBudgetFor(entry('asr'))).toThrow(NoLatencyBudget);
  });

  it('leaves a row with no SLO unbounded, and a p95 row as stated', () => {
    expect(latencyBudgetFor(entry('embed'))).toBe(Number.POSITIVE_INFINITY);
    expect(latencyBudgetFor(entry('sql.generate'))).toBe(800);
  });

  it('scores an ASR model against the same audio the budget came from', () => {
    const risk = (audioSeconds: number, budgetMs: number) => {
      const decision = route(DEFAULT_POLICY, asr({ audioSeconds, latencyBudgetMs: budgetMs }));
      return decision.candidates.find((c) => c.model.id === 'whisper-large-v3')!.latencyRisk;
    };
    // Whisper's p95 is 0.11x. An hour of audio against its 0.15x budget, and a
    // thirty-second clip against its own, are the same situation and score the
    // same: comfortably inside.
    const hour = risk(3_600, latencyBudgetFor(entry('asr'), { audioSeconds: 3_600 }));
    const clip = risk(30, latencyBudgetFor(entry('asr'), { audioSeconds: 30 }));
    expect(hour).toBeLessThan(0.05);
    expect(clip).toBeCloseTo(hour, 12);
    // The old fixed ten seconds, applied to the hour: nowhere near enough, and
    // the score now says so instead of measuring a transcription against a
    // millisecond figure for a short request.
    expect(risk(3_600, 10_000)).toBeGreaterThan(0.95);
  });

  it('keeps transcription of positions-classified audio off the vendor', () => {
    // The hard rule outranks the realtime score: a positions call is routed to
    // the self-hosted model whatever the vendor's latency.
    const decision = route(
      DEFAULT_POLICY,
      asr({ audioSeconds: 600, latencyBudgetMs: latencyBudgetFor(entry('asr'), { audioSeconds: 600 }), dataSensitivity: 'positions' }),
    );
    expect(decision.model.id).toBe('whisper-large-v3');
    expect(decision.excluded.map((e) => e.modelId)).toContain('vendor-asr');
  });
});

describe('escalation on a property of the input', () => {
  function extract(overrides: Partial<RoutingFeatures> = {}): RoutingFeatures {
    return {
      taskClass: 'doc.extract',
      inputTokens: 6_000,
      expectedOutputTokens: 400,
      modalities: ['text', 'table'],
      toolsRequired: [],
      rigorFlag: false,
      dataSensitivity: 'public',
      costCeilingCents: 50,
      latencyBudgetMs: 3_000,
      determinismRequired: false,
      priorFailures: [],
      ...overrides,
    };
  }

  it('sends a filing with a footnote cross-reference straight to the fallback tier', () => {
    // PRD 4.2: "Table ambiguity or footnote cross-reference". Known before the
    // first dispatch, so the primary is not given a chance to fail on it.
    const plain = route(DEFAULT_POLICY, extract());
    expect(plain.model.placement).toBe('self_hosted');
    const flagged = route(DEFAULT_POLICY, extract({ signals: ['footnote_xref'] }));
    expect(flagged.model.id).toBe('frontier-a');
    expect(flagged.reasons[0]).toContain('footnote_xref');
  });

  it('sends low-SNR audio to the vendor ASR', () => {
    const budget = latencyBudgetFor(entry('asr'), { audioSeconds: 1_800 });
    expect(route(DEFAULT_POLICY, asr({ audioSeconds: 1_800, latencyBudgetMs: budget, signals: ['low_snr'] })).model.id).toBe(
      'vendor-asr',
    );
  });

  it('ignores a signal the row does not escalate on', () => {
    const decision = route(DEFAULT_POLICY, extract({ signals: ['low_snr'] }));
    expect(decision.model.id).toBe(route(DEFAULT_POLICY, extract()).model.id);
  });

  it('stays inside the tenant when the fallback would leave it, and says why', () => {
    // The hard rule outranks the signal: positions-classified audio with low
    // SNR is transcribed self-hosted, and the decision names what was refused.
    const budget = latencyBudgetFor(entry('asr'), { audioSeconds: 600 });
    const decision = route(
      DEFAULT_POLICY,
      asr({ audioSeconds: 600, latencyBudgetMs: budget, dataSensitivity: 'positions', signals: ['low_snr'] }),
    );
    expect(decision.model.id).toBe('whisper-large-v3');
    expect(decision.reasons.join(' ')).toContain('low_snr would escalate to vendor-asr');
  });
});
