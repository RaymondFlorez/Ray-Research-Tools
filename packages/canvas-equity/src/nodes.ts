/**
 * The 5.2 node constructors.
 *
 * "Nodes: `EquityTile`, `FundamentalsTable`, `EstimateRevisionChart`,
 * `FactorExposureNode` ..., `EventStudyNode` ..., `ERQ12Node`, `AXM8Node`."
 *
 * **ERQ12 and AXM8 are not built here, and cannot be.** The PRD names them as
 * "the platform earnings rubric from LEDGER" and a companion node, and gives no
 * definition of either — no inputs, no components, no scale, no weighting. A
 * rubric invented to fill the gap would carry the name of a real house
 * methodology while computing something nobody agreed to, which is worse than
 * a gap: an analyst reading "ERQ12: 7.4" has no way to know it is fabricated.
 * `erq12Node` and `axm8Node` therefore build the node with its ports and mark
 * it `error` with a reason naming what is missing.
 *
 * The rest are real, and the two that carry analysis — `FactorExposureNode` and
 * `EventStudyNode` — expose their diagnostics as output ports rather than as
 * tooltips, so the R-squared and the clustering verdict can be wired into
 * something that acts on them.
 */

import { createNode, type Frequency, type PicassoNode, type Port } from '@picasso/canvas-core';

function port(
  id: string,
  name: string,
  type: Port['type'],
  required = false,
  extra: Partial<Port> = {},
): Port {
  return { id, name, type, cardinality: 'one', required, ...extra };
}

export interface EquityTileInput {
  id: string;
  symbol: string;
  frequency: Frequency;
  history?: number;
}

export function equityTile(input: EquityTileInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'DataTile',
    binding: 'wired',
    outputs: [
      port('price', 'price', 'series', false, {
        emits: {
          frequency: input.frequency,
          assetClass: 'equity',
          ...(input.history !== undefined ? { history: input.history } : {}),
        },
      }),
      port('volume', 'volume', 'series', false, {
        emits: { frequency: input.frequency, assetClass: 'equity' },
      }),
    ],
    params: { symbol: input.symbol },
  });
}

export interface FundamentalsInput {
  id: string;
  symbol: string;
  /**
   * PRD 5.2: fundamentals are point-in-time "with both original and restated
   * views". Both are emitted, because the difference between them is the
   * finding for anyone who has been burned by a silent restatement.
   */
  view: 'original' | 'restated' | 'both';
}

export function fundamentalsTable(input: FundamentalsInput): PicassoNode {
  const outputs: Port[] = [];
  if (input.view === 'original' || input.view === 'both') {
    outputs.push(port('original', 'as originally reported', 'table'));
  }
  if (input.view === 'restated' || input.view === 'both') {
    outputs.push(port('restated', 'as restated', 'table'));
  }
  if (input.view === 'both') {
    outputs.push(port('adjustments', 'restatement adjustments', 'series'));
  }
  return createNode({
    id: input.id,
    kind: 'TableNode',
    binding: 'wired',
    outputs,
    params: { symbol: input.symbol, view: input.view },
  });
}

export function estimateRevisionChart(id: string, symbol: string, metric: string): PicassoNode {
  return createNode({
    id,
    kind: 'ChartNode',
    binding: 'wired',
    outputs: [
      port('consensus', 'consensus', 'series'),
      port('revisions', 'revision history', 'series'),
      port('dispersion', 'estimate dispersion', 'series'),
    ],
    params: { symbol, metric },
  });
}

export interface FactorExposureNodeInput {
  id: string;
  factors: readonly string[];
  window: [string, string];
}

export function factorExposureNode(input: FactorExposureNodeInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'FactorNode',
    binding: 'wired',
    inputs: [
      port('returns', 'returns', 'series', true, { constraints: { minHistory: 60 } }),
    ],
    outputs: [
      port('betas', 'exposures', 'table'),
      port('alpha', 'alpha', 'scalar'),
      // Diagnostics as ports, not tooltips: a downstream node can refuse to
      // act on a loading whose fit does not support it.
      port('rSquared', 'r squared', 'scalar'),
      port('vif', 'variance inflation', 'table'),
    ],
    params: { factors: [...input.factors], window: [...input.window] },
  });
}

export interface EventStudyNodeInput {
  id: string;
  model: 'market_model' | 'ff3' | 'matched_firm';
  window: [number, number];
}

export function eventStudyNode(input: EventStudyNodeInput): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'TransformNode',
    binding: 'wired',
    inputs: [
      port('events', 'event set', 'event', true, { cardinality: 'many' } as Partial<Port>),
      port('returns', 'returns', 'series', true),
    ],
    outputs: [
      port('car', 'cumulative abnormal return', 'series'),
      port('caar', 'mean CAR', 'scalar'),
      port('t', 'test statistic', 'scalar'),
      // The clustering verdict is an output because it decides which t is the
      // real one, and that is not a footnote on a chart.
      port('clustering', 'event clustering', 'table'),
    ],
    params: { model: input.model, window: [...input.window] },
  });
}

/** What a node reports when the platform rubric behind it is unspecified. */
export const UNSPECIFIED_RUBRIC = 'unspecified_rubric';

function unspecifiedRubric(id: string, rubric: string, source: string): PicassoNode {
  const node = createNode({
    id,
    kind: 'ScoringNode',
    binding: 'wired',
    inputs: [port('subject', 'subject', 'instrument', true)],
    outputs: [port('score', 'score', 'scalar'), port('components', 'components', 'table')],
    params: { rubric },
  });
  node.state = {
    status: 'error',
    error: {
      code: UNSPECIFIED_RUBRIC,
      message:
        `${rubric} is ${source}, and its components, weighting and scale are not specified anywhere ` +
        'available here. The node is present so a canvas that references it loads, but it computes ' +
        'nothing: a score invented to fill the gap would carry the name of a real methodology.',
      retriable: false,
    },
  };
  return node;
}

export function erq12Node(id: string): PicassoNode {
  return unspecifiedRubric(id, 'ERQ12', 'the platform earnings rubric from LEDGER');
}

export function axm8Node(id: string): PicassoNode {
  return unspecifiedRubric(id, 'AXM8', 'a platform scoring node named in PRD 5.2');
}
