/**
 * Shock propagation over a causal graph (PRD 3.4, 5.6).
 *
 * "`CausalNode` graphs are the exception: they are explicitly cyclic and
 * evaluate under discrete-time fixed-point semantics with a user-set horizon
 * and damping factor, with divergence detection that halts and reports rather
 * than spinning."
 *
 * The data DAG forbids cycles because a value that depends on itself has no
 * value. A causal map is the opposite: "rates up → multiples down → risk
 * appetite down → rates down" is a feedback loop an analyst means to assert, and
 * refusing to draw it would be refusing to model the thing.
 *
 * What a cycle needs instead is a semantics. Here it is discrete time: a shock
 * at `t` reaches its target at `t + lag`, scaled by the edge's elasticity and
 * by a damping factor per hop. A loop whose round-trip gain is under one decays
 * to a fixed point; one whose gain exceeds it grows without bound, and the run
 * **halts and says so** rather than returning a large number as though it meant
 * something.
 */

import type { EdgeID, NodeID } from '@picasso/canvas-core';

/** One asserted link: a shock to `from` moves `to`, `lag` periods later. */
export interface CausalLink {
  id: EdgeID;
  from: NodeID;
  to: NodeID;
  /** Response of `to` per unit of `from`. Signed. */
  elasticity: number;
  /** Periods between cause and effect. Zero is contemporaneous. */
  lag: number;
  /** How the number was arrived at, which decides how much to trust the path. */
  method: 'asserted' | 'local_projection' | 'var' | 'cited';
  /** Present for estimated edges. */
  rSquared?: number;
  standardError?: number;
  /** Set when the edge's own estimate was unstable across regimes. */
  unstable?: boolean;
}

export interface PropagateOptions {
  /** Periods to run. PRD calls this user-set; twenty-four is a sensible default. */
  horizon?: number;
  /**
   * Per-hop multiplier, in `(0, 1]`.
   *
   * Not a fudge factor: an asserted elasticity is a local, short-run response,
   * and applying it undiminished around a loop assumes the relationship holds
   * exactly as far as the loop goes. Damping states how fast that confidence
   * decays, and one means the analyst is claiming it does not.
   */
  damping?: number;
  /** Magnitude at which the run is declared divergent. */
  divergenceLimit?: number;
}

export interface Divergence {
  node: NodeID;
  period: number;
  magnitude: number;
  /** The cycle responsible, when one can be identified. */
  cycle?: NodeID[];
}

export interface Propagation {
  /** Impulse response per node: the value at each period. */
  series: Map<NodeID, number[]>;
  /** Cumulative response per node over the horizon. */
  total: Map<NodeID, number>;
  /** Cycles the graph contains, as node sequences. */
  cycles: NodeID[][];
  /** Set when the run halted early. `series` then holds what it had. */
  diverged?: Divergence;
  /** Periods actually run. */
  periods: number;
  /**
   * Edges whose elasticity is asserted rather than estimated, or estimated
   * badly. PRD 9's assumption audit, restricted to the paths this shock used.
   */
  assumptions: string[];
}

/** PRD 9: below this, an estimated edge is an assumption. */
export const WEAK_R_SQUARED = 0.2;

/**
 * Runs a shock through the graph.
 *
 * `shocks` is the impulse at period zero, in the units each node is measured
 * in. Everything downstream is in those units times the elasticities along the
 * path, which is what makes a causal map readable end to end: "Fed hawkish →
 * real rates up → multiple compression → my Jan calls −34 percent".
 */
export function propagate(
  links: readonly CausalLink[],
  shocks: ReadonlyMap<NodeID, number>,
  options: PropagateOptions = {},
): Propagation {
  const horizon = Math.max(1, options.horizon ?? 24);
  const damping = options.damping ?? 0.9;
  const limit = options.divergenceLimit ?? 1e6;

  const nodes = new Set<NodeID>();
  for (const link of links) {
    nodes.add(link.from);
    nodes.add(link.to);
  }
  for (const node of shocks.keys()) nodes.add(node);

  const series = new Map<NodeID, number[]>();
  for (const node of nodes) series.set(node, new Array<number>(horizon + 1).fill(0));
  for (const [node, size] of shocks) {
    const row = series.get(node);
    if (row) row[0] = size;
  }

  const outgoing = new Map<NodeID, CausalLink[]>();
  for (const link of links) {
    const list = outgoing.get(link.from) ?? [];
    list.push(link);
    outgoing.set(link.from, list);
  }

  const cycles = findCycles(links);
  let diverged: Divergence | undefined;
  let periods = horizon;

  for (let t = 0; t <= horizon && !diverged; t += 1) {
    for (const node of nodes) {
      const value = (series.get(node) as number[])[t] as number;
      if (value === 0) continue;
      for (const link of outgoing.get(node) ?? []) {
        // A contemporaneous edge inside a cycle would let a shock reach itself
        // in the same period, which is an infinite sum rather than a
        // propagation. One period is the floor, so time always advances.
        const lag = Math.max(link.lag, 1);
        const arrival = t + lag;
        if (arrival > horizon) continue;
        const target = series.get(link.to) as number[];
        target[arrival] = (target[arrival] as number) + value * link.elasticity * damping;
      }
    }

    // Check after the period is fully written, so the magnitude reported is the
    // one that actually appeared rather than a partial sum.
    for (const node of nodes) {
      const magnitude = Math.abs((series.get(node) as number[])[t] as number);
      if (magnitude > limit) {
        diverged = {
          node,
          period: t,
          magnitude,
          ...(cycles.find((c) => c.includes(node)) !== undefined
            ? { cycle: cycles.find((c) => c.includes(node)) as NodeID[] }
            : {}),
        };
        periods = t;
        break;
      }
    }
  }

  const total = new Map<NodeID, number>();
  for (const [node, row] of series) {
    total.set(node, row.slice(0, periods + 1).reduce((sum, v) => sum + v, 0));
  }

  return {
    series,
    total,
    cycles,
    periods,
    assumptions: auditLinks(links),
    ...(diverged !== undefined ? { diverged } : {}),
  };
}

/**
 * Every edge the analyst should not lean on, named.
 *
 * PRD 9 asks the assumption audit to "enumerate every node whose param was set
 * by hand rather than derived, and every mapping whose estimation R-squared
 * falls below 0.2". An asserted edge is not wrong — it is a hypothesis, and
 * PRD 5.6's point is that Picasso "will happily tell the analyst that the
 * elasticity they asserted has an R-squared of 0.04 over their chosen window".
 */
export function auditLinks(links: readonly CausalLink[]): string[] {
  const lines: string[] = [];
  for (const link of links) {
    const edge = `${link.from} → ${link.to}`;
    if (link.method === 'asserted') {
      lines.push(`${edge}: elasticity ${link.elasticity} asserted by hand, never estimated`);
      continue;
    }
    if (link.method === 'cited') {
      lines.push(`${edge}: elasticity ${link.elasticity} taken from a citation, not re-estimated here`);
      continue;
    }
    if (link.rSquared !== undefined && link.rSquared < WEAK_R_SQUARED) {
      lines.push(
        `${edge}: estimated at ${link.elasticity.toFixed(2)} but R² is ` +
          `${link.rSquared.toFixed(2)} — the window does not support it`,
      );
    }
    if (link.unstable) {
      lines.push(`${edge}: elasticity is unstable across regimes; the single number averages two`);
    }
  }
  return lines;
}

/**
 * Every cycle in the graph, by depth-first search.
 *
 * Reported rather than rejected. A causal map is allowed to have them — the
 * point is that the analyst can see which loops they drew, because a loop is
 * where a small elasticity error compounds into a large one.
 */
export function findCycles(links: readonly CausalLink[]): NodeID[][] {
  const outgoing = new Map<NodeID, NodeID[]>();
  for (const link of links) {
    const list = outgoing.get(link.from) ?? [];
    list.push(link.to);
    outgoing.set(link.from, list);
  }

  const cycles: NodeID[][] = [];
  const seen = new Set<string>();
  const onPath: NodeID[] = [];
  const inPath = new Set<NodeID>();
  const finished = new Set<NodeID>();

  const walk = (node: NodeID): void => {
    inPath.add(node);
    onPath.push(node);
    for (const next of outgoing.get(node) ?? []) {
      if (inPath.has(next)) {
        const start = onPath.indexOf(next);
        const cycle = onPath.slice(start);
        // Normalised so the same loop found from two entry points is one cycle.
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!finished.has(next)) {
        walk(next);
      }
    }
    inPath.delete(node);
    onPath.pop();
    finished.add(node);
  };

  for (const node of outgoing.keys()) {
    if (!finished.has(node)) walk(node);
  }
  return cycles;
}

/**
 * The round-trip gain of a cycle: the product of its elasticities and damping.
 *
 * Under one and the loop settles; over one it runs away. Computable before
 * anything is run, which is how a node can warn instead of waiting to diverge.
 */
export function cycleGain(
  links: readonly CausalLink[],
  cycle: readonly NodeID[],
  damping = 0.9,
): number {
  let gain = 1;
  for (let i = 0; i < cycle.length; i += 1) {
    const from = cycle[i] as NodeID;
    const to = cycle[(i + 1) % cycle.length] as NodeID;
    const link = links.find((l) => l.from === from && l.to === to);
    if (!link) return 0;
    gain *= link.elasticity * damping;
  }
  return gain;
}
