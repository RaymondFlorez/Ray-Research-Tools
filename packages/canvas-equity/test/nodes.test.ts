import { describe, expect, it } from 'vitest';
import {
  NAMED_FRAMEWORKS,
  UNSPECIFIED_RUBRIC,
  axm8Node,
  bpsNode,
  scoringNode,
  sivNode,
  equityTile,
  erq12Node,
  estimateRevisionChart,
  eventStudyNode,
  factorExposureNode,
  fundamentalsTable,
} from '../src/nodes.js';

describe('the data nodes', () => {
  it('emit equity series with their frequency and asset class stamped', () => {
    const tile = equityTile({ id: 't', symbol: 'NVDA', frequency: 'daily', history: 500 });
    expect(tile.outputs[0]?.emits).toMatchObject({ frequency: 'daily', assetClass: 'equity', history: 500 });
  });

  // "fundamentals as point-in-time with both original and restated views".
  // The difference between them is the finding for anyone who has been burned
  // by a silent restatement, so it is its own port.
  it('emit the restatement adjustments as a wireable series, not a footnote', () => {
    const both = fundamentalsTable({ id: 'f', symbol: 'NVDA', view: 'both' });
    expect(both.outputs.map((p) => p.id)).toEqual(['original', 'restated', 'adjustments']);

    const single = fundamentalsTable({ id: 'f', symbol: 'NVDA', view: 'original' });
    expect(single.outputs.map((p) => p.id)).toEqual(['original']);
  });

  it('expose revision history and dispersion, not just the consensus point', () => {
    const chart = estimateRevisionChart('c', 'NVDA', 'eps');
    expect(chart.outputs.map((p) => p.id)).toEqual(['consensus', 'revisions', 'dispersion']);
  });
});

describe('the analysis nodes expose their diagnostics as ports', () => {
  // Not tooltips: a downstream node can refuse to act on a loading whose fit
  // does not support it.
  it('give the factor node an r-squared and a VIF output', () => {
    const node = factorExposureNode({ id: 'f', factors: ['mkt', 'smb'], window: ['2021-01-01', '2026-01-01'] });
    expect(node.outputs.map((p) => p.id)).toContain('rSquared');
    expect(node.outputs.map((p) => p.id)).toContain('vif');
  });

  // The clustering verdict decides which t-statistic is the real one, and that
  // is not a footnote on a chart.
  it('give the event study node a clustering output', () => {
    const node = eventStudyNode({ id: 'e', model: 'ff3', window: [-5, 5] });
    expect(node.outputs.map((p) => p.id)).toContain('clustering');
    expect(node.params.model).toBe('ff3');
  });
});

describe('the rubric nodes the PRD names but does not define', () => {
  // A rubric invented to fill the gap would carry the name of a real house
  // methodology while computing something nobody agreed to. An analyst reading
  // "ERQ12: 7.4" would have no way to know it was fabricated.
  it('load, and refuse to compute, and say exactly what is missing', () => {
    for (const node of [erq12Node('e'), axm8Node('a'), sivNode('s'), bpsNode('b')]) {
      expect(node.state.status).toBe('error');
      expect(node.state.error?.code).toBe(UNSPECIFIED_RUBRIC);
      expect(node.state.error?.retriable).toBe(false);
      expect(node.state.error?.message).toContain('not specified');
      // The ports exist, so a canvas referencing them still loads and wires.
      expect(node.outputs.map((p) => p.id)).toEqual(['score', 'components']);
    }
  });

  it('name their source so the gap is attributable', () => {
    expect(erq12Node('e').state.error?.message).toContain('LEDGER');
    expect(sivNode('s').state.error?.message).toContain('PRD 3.3');
  });

  it('cover every framework PRD 3.3 names for a ScoringNode, and compute none', () => {
    // AXM-8, ERQ-12, SIV, BPS: four names, no definitions.
    expect([...NAMED_FRAMEWORKS]).toEqual(['AXM8', 'ERQ12', 'SIV', 'BPS']);
    for (const framework of NAMED_FRAMEWORKS) {
      const node = scoringNode(`n-${framework}`, framework);
      expect(node.kind).toBe('ScoringNode');
      expect(node.params.rubric).toBe(framework);
      expect(node.state.error?.code).toBe(UNSPECIFIED_RUBRIC);
    }
  });
});
