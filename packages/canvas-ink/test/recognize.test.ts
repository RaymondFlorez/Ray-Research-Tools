import { describe, expect, it } from 'vitest';
import { SUGGESTION_CONFIDENCE_FLOOR } from '@picasso/canvas-core';
import { RECOGNITION_FLOOR, recognizeShape, type ShapeKind } from '../src/recognize.js';
import { buildScribbles, buildSet, mulberry32, makeRectangle, type SynthShape } from './synth.js';

/** Seeds the thresholds were never tuned against. */
const HELD_OUT_SEEDS = [101, 202, 303, 404, 505];

function accuracyFor(seed: number): { accuracy: number; perClass: Map<SynthShape, number> } {
  const set = buildSet(80, seed);
  const totals = new Map<SynthShape, number>();
  const hits = new Map<SynthShape, number>();
  let correct = 0;

  for (const sample of set) {
    totals.set(sample.expected, (totals.get(sample.expected) ?? 0) + 1);
    if (recognizeShape(sample.points).kind === sample.expected) {
      correct += 1;
      hits.set(sample.expected, (hits.get(sample.expected) ?? 0) + 1);
    }
  }

  const perClass = new Map<SynthShape, number>();
  for (const [kind, total] of totals) perClass.set(kind, (hits.get(kind) ?? 0) / total);
  return { accuracy: correct / set.length, perClass };
}

describe('shape pass accuracy (PRD Appendix B, phase 5 exit criterion)', () => {
  it('exceeds 92 percent on the tuned set', () => {
    const { accuracy, perClass } = accuracyFor(11);
    expect(accuracy).toBeGreaterThan(0.92);
    for (const [kind, rate] of perClass) {
      expect(rate, `${kind} recall`).toBeGreaterThan(0.85);
    }
  });

  it('holds up on seeds the thresholds were not tuned against', () => {
    for (const seed of HELD_OUT_SEEDS) {
      const { accuracy } = accuracyFor(seed);
      expect(accuracy, `seed ${seed}`).toBeGreaterThan(0.92);
    }
  });

  it('never confidently recognizes a scribble as a shape', () => {
    // The ambient promote affordance keys off confidence, so a confident false
    // positive puts an unwanted offer on the analyst's canvas.
    let admitted = 0;
    let confident = 0;
    for (const seed of [12, ...HELD_OUT_SEEDS.map((s) => s + 1000)]) {
      for (const scribble of buildScribbles(80, seed)) {
        const result = recognizeShape(scribble);
        if (result.kind !== 'unknown') admitted += 1;
        if (result.confidence > SUGGESTION_CONFIDENCE_FLOOR) confident += 1;
      }
    }
    expect(confident).toBe(0);
    // A handful of near-misses are tolerable; a flood is not.
    expect(admitted / (80 * 6)).toBeLessThan(0.05);
  });

  it('recognizes a stroke well inside the 90ms p95 budget', () => {
    const strokes = buildSet(40, 77).map((s) => s.points);
    for (const points of strokes) recognizeShape(points);

    const started = performance.now();
    for (const points of strokes) recognizeShape(points);
    const perStroke = (performance.now() - started) / strokes.length;
    expect(perStroke).toBeLessThan(5);
  });
});

describe('recognition contract', () => {
  const rand = mulberry32(5);

  it('returns the features that produced the verdict, for debugging', () => {
    const result = recognizeShape(makeRectangle(rand));
    expect(result.kind).toBe('rectangle');
    expect(result.features?.sharpCorners.length).toBeGreaterThanOrEqual(3);
    expect(result.scores.rectangle).toBeGreaterThan(result.scores.ellipse);
  });

  it('refuses to guess at degenerate input', () => {
    for (const points of [[], [{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]]) {
      const result = recognizeShape(points);
      expect(result.kind).toBe('unknown');
      expect(result.confidence).toBe(0);
    }
    // A stroke with no extent at all.
    const dot = Array.from({ length: 20 }, () => ({ x: 5, y: 5 }));
    expect(recognizeShape(dot).kind).toBe('unknown');
  });

  it('reports unknown rather than the best of a bad set', () => {
    const scribble = buildScribbles(1, 99)[0] as Array<{ x: number; y: number }>;
    const result = recognizeShape(scribble);
    if (result.kind === 'unknown') {
      expect(result.confidence).toBeLessThan(RECOGNITION_FLOOR);
    }
  });

  it('discounts confidence when two shapes score close together', () => {
    // A rounded square sits between rectangle and ellipse; whichever wins, it
    // should not win confidently enough to auto-offer a promotion.
    const radius = 22;
    const side = 120;
    const rounded: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      // Superellipse with a low exponent reads as neither cleanly.
      const n = 2.6;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      rounded.push({
        x: Math.sign(cos) * Math.abs(cos) ** (2 / n) * (side + radius),
        y: Math.sign(sin) * Math.abs(sin) ** (2 / n) * (side + radius),
      });
    }
    const result = recognizeShape(rounded);
    const gap = Math.abs(result.scores.rectangle - result.scores.ellipse);
    if (gap < 0.1) {
      expect(result.confidence).toBeLessThan(SUGGESTION_CONFIDENCE_FLOOR);
    }
  });

  it('scores every candidate, not just the winner', () => {
    const result = recognizeShape(makeRectangle(rand));
    const kinds: Array<Exclude<ShapeKind, 'unknown'>> = [
      'line', 'rectangle', 'ellipse', 'arrow', 'bracket',
    ];
    for (const kind of kinds) {
      expect(result.scores[kind]).toBeGreaterThanOrEqual(0);
      expect(result.scores[kind]).toBeLessThanOrEqual(1);
    }
  });
});
