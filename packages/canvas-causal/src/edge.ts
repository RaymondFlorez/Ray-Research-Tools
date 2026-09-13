/**
 * Causal edges on the canvas (PRD 3.4, Appendix A).
 *
 * `@picasso/canvas-core` has carried `CausalEdgeParams` since Phase 0, with an
 * `estimation` block naming a method, a window, an R² and a standard error.
 * Nothing has ever filled it in. This module is what fills it in.
 *
 * The shape of the walkthrough in PRD 7.4: "She draws an arrow from the
 * `RateShock` node to her software basket node and labels it 'duration.' The
 * system creates a causal edge, estimates the elasticity over her chosen
 * window, and reports −2.1 with a standard error wide enough that she narrows
 * the window and re-estimates."
 *
 * Every part of that sentence is a requirement. The edge exists before it is
 * estimated; the estimate carries an error the analyst can react to; and the
 * window is the control they reach for.
 */

import type { CausalEdgeParams, CanvasDocument, Edge, EdgeID, NodeID } from '@picasso/canvas-core';
import { estimateWithRegimes, type RegimeEstimate } from './regime.js';
import type { LocalProjectionOptions } from './estimate.js';
import type { CausalLink } from './propagate.js';

export interface EstimateEdgeInput {
  /** The cause, as a series of changes. */
  cause: readonly number[];
  /** The effect, aligned to the same periods. */
  effect: readonly number[];
  /** The window these observations cover, recorded on the edge. */
  window: readonly [string, string];
  /**
   * Periods between cause and effect.
   *
   * Omit to let the estimator find where the response peaks — which is the
   * honest default, because an analyst asserting a lag is asserting exactly the
   * dynamic structure C.3 says local projections exist to avoid imposing.
   */
  lagPeriods?: number;
  /** A break the analyst knows about, as an index into the series. */
  splitAt?: number;
  options?: LocalProjectionOptions;
}

export interface EstimatedEdge {
  params: CausalEdgeParams;
  /** The full-sample and per-regime estimates behind `params`. */
  regimes: RegimeEstimate;
  /** Set when the two regimes disagree; the analyst should narrow the window. */
  warning?: string;
}

/**
 * Estimates an edge from history.
 *
 * The elasticity written onto the edge is the **full-sample** one, because that
 * is what the analyst asked for — but when the regimes disagree the warning
 * travels with it, and `params.estimation.r2` is the full-sample R² so a weak
 * edge cannot hide behind a strong sub-period.
 */
export function estimateEdge(input: EstimateEdgeInput): EstimatedEdge | undefined {
  const horizons = input.options?.horizons ?? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
  let horizon = input.lagPeriods;

  if (horizon === undefined) {
    // Find the horizon where the response is largest, rather than assuming one.
    let best: { horizon: number; magnitude: number } | undefined;
    for (const candidate of horizons) {
      const fitted = estimateWithRegimes(input.cause, input.effect, candidate, {
        ...input.options,
        ...(input.splitAt !== undefined ? { splitAt: input.splitAt } : {}),
      });
      if (!fitted) continue;
      const magnitude = Math.abs(fitted.full.value);
      if (!best || magnitude > best.magnitude) best = { horizon: candidate, magnitude };
    }
    if (!best) return undefined;
    horizon = best.horizon;
  }

  const regimes = estimateWithRegimes(input.cause, input.effect, horizon, {
    ...input.options,
    ...(input.splitAt !== undefined ? { splitAt: input.splitAt } : {}),
  });
  if (!regimes) return undefined;

  const elasticity = regimes.full.value;
  const params: CausalEdgeParams = {
    sign: elasticity >= 0 ? 1 : -1,
    elasticity,
    lagPeriods: horizon,
    estimation: {
      method: 'local_projection',
      window: [input.window[0], input.window[1]],
      r2: regimes.full.rSquared,
      se: regimes.full.standardError,
    },
  };

  return {
    params,
    regimes,
    ...(regimes.warning !== undefined ? { warning: regimes.warning } : {}),
  };
}

/**
 * An edge the analyst asserted rather than estimated.
 *
 * A first-class thing to do, and PRD 5.6 is explicit that Picasso's job is not
 * to refuse it but to keep saying what it is: "Picasso will happily tell the
 * analyst that the elasticity they asserted has an R-squared of 0.04 over their
 * chosen window." The method recorded here is what makes that possible later.
 */
export function assertEdge(elasticity: number, lagPeriods: number): CausalEdgeParams {
  return {
    sign: elasticity >= 0 ? 1 : -1,
    elasticity,
    lagPeriods,
    estimation: { method: 'asserted', window: ['', ''] },
  };
}

/** A causal edge, ready to add to a document. */
export function createCausalEdge(
  id: EdgeID,
  from: NodeID,
  to: NodeID,
  causal: CausalEdgeParams,
): Edge {
  return {
    id,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'causal',
    causal,
  };
}

/**
 * Reads a document's causal edges into links the propagator understands.
 *
 * Data edges are skipped: the DAG and the causal map are different graphs over
 * the same nodes, and a shock does not travel down a data wire. That separation
 * is also why the causal map is allowed cycles when the data graph is not
 * (PRD 3.4).
 */
export function linksFromDocument(
  doc: CanvasDocument,
  unstable: ReadonlySet<EdgeID> = new Set(),
): CausalLink[] {
  const links: CausalLink[] = [];
  for (const edge of doc.edges.values()) {
    if (edge.class !== 'causal' || !edge.causal) continue;
    const { elasticity, lagPeriods, estimation } = edge.causal;
    links.push({
      id: edge.id,
      from: edge.from.nodeId,
      to: edge.to.nodeId,
      elasticity,
      lag: lagPeriods,
      method: estimation?.method ?? 'asserted',
      ...(estimation?.r2 !== undefined ? { rSquared: estimation.r2 } : {}),
      ...(estimation?.se !== undefined ? { standardError: estimation.se } : {}),
      ...(unstable.has(edge.id) ? { unstable: true } : {}),
    });
  }
  return links;
}
