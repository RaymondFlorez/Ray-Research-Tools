import { describe, expect, it } from 'vitest';
import {
  SUGGESTION_CONFIDENCE_FLOOR,
  SUGGESTION_FADE_MS,
  applyDemotion,
  applyPromotion,
  defaultBindingForFrame,
  isSuggestionVisible,
  participatesInScheduler,
  proposePromotion,
  shouldOfferPromotion,
  type AnalystCommit,
} from '../src/binding.js';
import { node } from './fixtures.js';

const commit: AnalystCommit = { actor: 'maya', at: 1_700_000_000_000, via: 'keyboard' };

describe('binding states (PRD 3.2.1)', () => {
  it('promotes one rung at a time: loose -> bound -> wired', () => {
    const sketch = node({ binding: 'loose' });
    const first = proposePromotion(sketch);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.to).toBe('bound');

    const bound = applyPromotion(sketch, first, commit);
    expect(bound.binding).toBe('bound');

    const second = proposePromotion(bound);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.to).toBe('wired');
    expect(applyPromotion(bound, second, commit).binding).toBe('wired');
  });

  it('leaves the original node untouched: a proposal is not a mutation', () => {
    const sketch = node({ binding: 'loose' });
    const proposal = proposePromotion(sketch);
    expect(proposal.ok).toBe(true);
    expect(sketch.binding).toBe('loose');
  });

  it('carries the semantic pass proposal into the promoted node, and lets the analyst edit it', () => {
    const sketch = node({ binding: 'loose', kind: 'InkLayer' });
    const proposal = proposePromotion(sketch, {
      recognition: { kind: 'ChartNode', params: { ticker: 'NVDA' }, confidence: 0.93 },
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.proposedKind).toBe('ChartNode');

    const accepted = applyPromotion(sketch, proposal, commit);
    expect(accepted.kind).toBe('ChartNode');
    expect(accepted.params.ticker).toBe('NVDA');

    const edited = applyPromotion(sketch, proposal, commit, { params: { ticker: 'AMD' } });
    expect(edited.params.ticker).toBe('AMD');
  });

  it('refuses a stale proposal rather than moving a node twice', () => {
    const sketch = node({ binding: 'loose' });
    const proposal = proposePromotion(sketch);
    if (!proposal.ok) throw new Error('expected proposal');
    const bound = applyPromotion(sketch, proposal, commit);
    expect(() => applyPromotion(bound, proposal, commit)).toThrow(/stale/);
  });

  it('a promoted node is stale, not ready: it has not computed yet', () => {
    const sketch = node({ binding: 'loose', status: 'idle' });
    const proposal = proposePromotion(sketch);
    if (!proposal.ok) throw new Error('expected proposal');
    expect(applyPromotion(sketch, proposal, commit).state.status).toBe('stale');
  });

  it('unwires a wired node to bound, and freezes to loose with an asof stamp', () => {
    const live = node({ binding: 'wired', params: { pnl: 1234 } });
    live.state = { status: 'ready', cacheKey: 'abc' };

    const unwired = applyDemotion(live, commit);
    expect(unwired.binding).toBe('bound');

    const frozen = applyDemotion(live, commit, {
      mode: 'freeze',
      asof: '2026-02-01T21:00:00Z',
      now: 42,
    });
    expect(frozen.binding).toBe('loose');
    expect(frozen.frozen).toEqual({
      values: { pnl: 1234 },
      asof: '2026-02-01T21:00:00Z',
      frozenAt: 42,
      previousBinding: 'wired',
    });
    // A frozen card holds no cache key and never schedules.
    expect(frozen.state.cacheKey).toBeUndefined();
    expect(frozen.state.status).toBe('idle');
    expect(participatesInScheduler(frozen)).toBe(false);
  });

  it('promotion off loose clears the frozen card', () => {
    const live = node({ binding: 'wired' });
    const frozen = applyDemotion(live, commit, { mode: 'freeze' });
    const proposal = proposePromotion(frozen);
    if (!proposal.ok) throw new Error('expected proposal');
    expect(applyPromotion(frozen, proposal, commit).frozen).toBeUndefined();
  });
});

describe('ambient promote affordance (PRD 3.2.1 path 2)', () => {
  const recognition = { kind: 'ChartNode' as const, confidence: 0.9 };

  it('offers only above the confidence floor', () => {
    const sketch = node({ binding: 'loose' });
    expect(shouldOfferPromotion(sketch, { recognition })).toBe(true);
    expect(
      shouldOfferPromotion(sketch, {
        recognition: { ...recognition, confidence: SUGGESTION_CONFIDENCE_FLOOR },
      }),
    ).toBe(false);
    expect(shouldOfferPromotion(sketch, {})).toBe(false);
  });

  it('is suppressed entirely inside a sketch frame (PRD 3.2.4)', () => {
    const sketch = node({ binding: 'loose' });
    expect(
      shouldOfferPromotion(sketch, { recognition, frame: { id: 'f1', frameMode: 'sketch' } }),
    ).toBe(false);
    expect(
      shouldOfferPromotion(sketch, { recognition, frame: { id: 'f1', frameMode: 'live' } }),
    ).toBe(true);
  });

  it('is not offered when the semantic pass failed to resolve', () => {
    const sketch = node({ binding: 'loose' });
    expect(shouldOfferPromotion(sketch, { recognition, semanticResolved: false })).toBe(false);
  });

  it('fades after 20 seconds and does not return unless the object is edited', () => {
    const state = { nodeId: 'n', shownAt: 0 };
    expect(isSuggestionVisible(state, SUGGESTION_FADE_MS - 1)).toBe(true);
    expect(isSuggestionVisible(state, SUGGESTION_FADE_MS)).toBe(false);

    const dismissed = { nodeId: 'n', shownAt: 0, dismissedAt: SUGGESTION_FADE_MS };
    expect(isSuggestionVisible(dismissed, SUGGESTION_FADE_MS + 1_000)).toBe(false);

    const edited = { ...dismissed, lastEditedAt: SUGGESTION_FADE_MS + 5_000 };
    expect(isSuggestionVisible(edited, SUGGESTION_FADE_MS + 5_100)).toBe(true);
    expect(isSuggestionVisible(edited, SUGGESTION_FADE_MS * 2 + 5_100)).toBe(false);
  });
});

describe('frame defaults (PRD 3.2.4)', () => {
  it('sketch frames default new objects to loose, live frames to bound', () => {
    expect(defaultBindingForFrame('sketch')).toBe('loose');
    expect(defaultBindingForFrame('live')).toBe('bound');
    expect(defaultBindingForFrame(undefined)).toBe('loose');
  });
});
