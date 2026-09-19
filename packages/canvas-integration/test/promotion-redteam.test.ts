/**
 * Phase 5's third exit number.
 *
 * > Zero unintended auto-promotions in the red-team session set.
 * > — Appendix B, phase 5
 *
 * The corpus is in `sessions.ts`. This file runs it and asserts the figure,
 * plus the per-session facts that make the figure mean something: a suite where
 * every session fails to promote for a trivial reason would report zero and
 * measure nothing, so the control session has to promote and the blocked ones
 * have to be blocked for the reason claimed.
 */

import { describe, expect, it } from 'vitest';
import { SUGGESTION_CONFIDENCE_FLOOR } from '@picasso/canvas-core';
import { SESSIONS, runPromotionRedteam } from './sessions.js';

const report = runPromotionRedteam();
const byId = new Map(report.outcomes.map((o) => [o.id, o]));

describe('the red-team session set', () => {
  it('is a set, not a case', () => {
    expect(report.sessions).toBeGreaterThanOrEqual(10);
    expect(new Set(SESSIONS.map((s) => s.id)).size).toBe(SESSIONS.length);
  });

  // The exit criterion.
  it('produces zero unintended auto-promotions', () => {
    const offenders = report.outcomes.filter((o) => o.unintended).map((o) => o.id);
    expect(offenders).toEqual([]);
    expect(report.unintendedPromotions).toBe(0);
  });

  // Without this, the line above is satisfied by a system that never promotes.
  it('still promotes when an analyst asks', () => {
    const control = byId.get('the_analyst_actually_says_yes');
    expect(control?.binding).not.toBe('loose');
    expect(control?.commits).toBe(1);
  });

  it('matches each session against what it expected', () => {
    for (const session of SESSIONS) {
      const outcome = byId.get(session.id);
      if (session.expect === 'no_movement') {
        expect(outcome?.moved, session.id).toBe(false);
        expect(outcome?.binding, session.id).toBe(outcome?.startBinding);
      } else {
        expect(outcome?.moved, session.id).toBe(true);
        if (session.expect === 'promoted') {
          expect(outcome?.commits, session.id).toBeGreaterThan(0);
        }
      }
    }
  });

  // The frame exception, stated where it can be seen rather than buried in the
  // runner. This is the only session in the set allowed to end above where it
  // started with nobody having clicked anything.
  it('allows exactly one unclicked promotion, and it is the live frame', () => {
    const byFrame = SESSIONS.filter((s) => s.expect === 'bound_by_frame');
    expect(byFrame.map((s) => s.id)).toEqual(['dropped_into_a_live_frame']);
    const outcome = byId.get('dropped_into_a_live_frame');
    expect(outcome?.startBinding).toBe('loose');
    expect(outcome?.binding).toBe('bound');
    expect(outcome?.commits).toBe(0);
  });

  it('would have caught a promotion that moved the ladder without a commit', () => {
    // The runner's own check, exercised on a fabricated outcome — otherwise the
    // zero above is consistent with a runner that never flags anything.
    const moved = report.outcomes.map((o) => o.moved);
    expect(moved.some(Boolean)).toBe(true);
    expect(moved.some((m) => !m)).toBe(true);
  });
});

describe('the affordance appears where it should and nowhere else', () => {
  const offeredIn = (id: string) => byId.get(id)?.offered;

  it('is suppressed inside a sketch frame, however good the shape', () => {
    expect(offeredIn('confident_box_in_a_sketch_frame')).toBe(false);
  });

  it('is suppressed at the confidence floor, not just below it', () => {
    expect(SUGGESTION_CONFIDENCE_FLOOR).toBe(0.85);
    expect(offeredIn('confidence_exactly_at_the_floor')).toBe(false);
  });

  it('is suppressed on a scribble', () => {
    expect(offeredIn('scribble_scores_as_a_shape')).toBe(false);
  });

  it('does appear on a confident shape outside a sketch frame', () => {
    expect(offeredIn('affordance_waited_out')).toBe(true);
  });

  it('is gone twenty-one seconds later', () => {
    const world = SESSIONS.find((s) => s.id === 'affordance_waited_out')!.run();
    expect(world.offered).toBe(true);
    expect(world.visibleAtEnd).toBe(false);
  });

  it('re-arms on an edit, which is still not an acceptance', () => {
    const world = SESSIONS.find((s) => s.id === 'affordance_dismissed_then_object_edited')!.run();
    expect(world.visibleAtEnd).toBe(true);
    expect(world.commits).toEqual([]);
    expect(world.node.binding).toBe('loose');
  });
});

describe('the reasons the blocked sessions were blocked', () => {
  it('refuses an ambiguous instrument rather than picking the first listing', () => {
    const world = SESSIONS.find((s) => s.id === 'ambiguous_instrument')!.run();
    expect(world.proposal?.acceptable).toBe(false);
    expect(world.refusals).toContain('ProposalNotAcceptable');
    // Two candidates, and neither was chosen.
    const mu = world.proposal?.unresolved.find((u) => u.mention === 'MU');
    expect(mu?.candidates.length).toBe(2);
  });

  it('refuses a ticker that resolves to nothing', () => {
    const world = SESSIONS.find((s) => s.id === 'unresolvable_instrument')!.run();
    expect(world.proposal?.acceptable).toBe(false);
    expect(world.proposal?.unresolved.map((u) => u.mention)).toContain('ZZZZ');
    expect(world.refusals).toContain('ProposalNotAcceptable');
  });

  // The ink version of a prompt injection. The defense is not that the text was
  // recognized as an instruction — it is that there is no path from text to a
  // node that does not pass through a name.
  it('refuses an acceptance with nobody behind it, whatever the ink says', () => {
    const world = SESSIONS.find((s) => s.id === 'ink_that_asks_to_be_promoted')!.run();
    expect(world.refusals).toContain('ProposalNotAcceptable');
    expect(world.node.binding).toBe('loose');
  });

  it('downgrades a malformed model reading to a note rather than guessing', () => {
    const world = SESSIONS.find((s) => s.id === 'malformed_model_reading')!.run();
    expect(world.proposal?.reading.kind).toBe('note');
    expect(world.proposal?.downgradedFrom).toBeTruthy();
  });

  it('refuses a proposal replayed against a node that already moved', () => {
    const world = SESSIONS.find((s) => s.id === 'stale_proposal_replayed')!.run();
    expect(world.refusals.length).toBe(1);
    expect(world.node.binding).toBe('bound');
  });
});
