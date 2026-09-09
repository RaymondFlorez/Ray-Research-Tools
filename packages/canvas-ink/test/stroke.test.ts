import { describe, expect, it } from 'vitest';
import {
  GROUP_GAP_MS,
  RECOGNITION_DELAY_MS,
  RecognitionScheduler,
  StrokeBuilder,
  groupStrokes,
  mergeGroup,
  pressureWidth,
  strokeBounds,
  strokeEnd,
  strokePoints,
  strokeStart,
  type InkPoint,
  type InkStroke,
} from '../src/stroke.js';
import { recognizeShape } from '../src/recognize.js';

function run(from: number, to: number, y: number, t0: number): InkPoint[] {
  const out: InkPoint[] = [];
  for (let x = from; x <= to; x += 2) {
    out.push({ x, y, pressure: 0.5, t: t0 + x });
  }
  return out;
}

describe('stroke capture (PRD 3.7)', () => {
  it('appends coalesced batches as runs and never touches what is already there', () => {
    const builder = new StrokeBuilder('s1');
    builder.append(run(0, 10, 0, 0));
    const firstRun = builder.current.runs[0];
    const snapshot = JSON.stringify(firstRun);

    builder.append(run(12, 20, 0, 100));
    expect(builder.current.runs).toHaveLength(2);
    // The earlier run is untouched: that is what makes ink conflict-free.
    expect(JSON.stringify(builder.current.runs[0])).toBe(snapshot);
    expect(builder.current.runs[0]).toBe(firstRun);
  });

  it('copies incoming points, so a reused event buffer cannot corrupt the stroke', () => {
    const builder = new StrokeBuilder('s1');
    const batch: InkPoint[] = [{ x: 1, y: 1, pressure: 0.4, t: 0 }];
    builder.append(batch);
    (batch[0] as InkPoint).x = 999;
    expect(builder.current.runs[0]?.points[0]?.x).toBe(1);
  });

  it('drops empty batches rather than storing them', () => {
    const builder = new StrokeBuilder('s1');
    builder.append([]);
    expect(builder.current.runs).toHaveLength(0);
  });

  it('simplifies only at commit, and only then', () => {
    const builder = new StrokeBuilder('s1');
    // 200 samples down a straight line, as a 240Hz stylus would produce.
    for (let i = 0; i < 10; i++) builder.append(run(i * 20, i * 20 + 18, 0, i * 100));
    const captured = builder.pointCount;
    expect(captured).toBeGreaterThan(90);
    expect(builder.current.runs).toHaveLength(10);

    const committed = builder.commit();
    expect(committed.committed).toBe(true);
    expect(committed.runs).toHaveLength(1);
    expect(strokePoints(committed).length).toBeLessThan(captured / 10);
    // The shape survives: endpoints are exact.
    expect(strokeStart(committed)?.x).toBe(0);
    expect(strokeEnd(committed)?.x).toBe(198);
  });

  it('reports points, bounds and endpoints across runs', () => {
    const builder = new StrokeBuilder('s1', { color: '#333', width: 2 });
    builder.append(run(0, 10, 5, 0));
    builder.append(run(12, 30, 25, 50));
    const stroke = builder.current;

    expect(strokePoints(stroke).length).toBe(builder.pointCount);
    expect(strokeBounds(stroke)).toEqual({ minX: 0, minY: 5, maxX: 30, maxY: 25 });
    expect(strokeStart(stroke)?.x).toBe(0);
    expect(strokeEnd(stroke)?.x).toBe(30);
    expect(stroke.color).toBe('#333');
  });

  it('maps pressure to width without ever vanishing', () => {
    expect(pressureWidth(1, 4)).toBe(4);
    expect(pressureWidth(0, 4)).toBeCloseTo(1.4, 6);
    expect(pressureWidth(0.5, 4)).toBeGreaterThan(pressureWidth(0.2, 4));
    // Out-of-range input is clamped, not trusted.
    expect(pressureWidth(5, 4)).toBe(4);
    expect(pressureWidth(-1, 4)).toBeCloseTo(1.4, 6);
  });
});

describe('stroke grouping', () => {
  function stroke(id: string, points: InkPoint[]): InkStroke {
    return { id, runs: [{ points }], committed: true };
  }

  it('groups strokes drawn close together in time and space', () => {
    const strokes = [
      stroke('top', run(0, 100, 0, 0)),
      stroke('right', [{ x: 100, y: 0, pressure: 0.5, t: 200 }, { x: 100, y: 100, pressure: 0.5, t: 260 }]),
    ];
    expect(groupStrokes(strokes)).toHaveLength(1);
  });

  it('starts a new group after a pause', () => {
    const strokes = [
      stroke('a', run(0, 100, 0, 0)),
      stroke('b', run(0, 100, 10, GROUP_GAP_MS + 5_000)),
    ];
    expect(groupStrokes(strokes)).toHaveLength(2);
  });

  it('starts a new group for ink drawn somewhere else', () => {
    const strokes = [
      stroke('a', run(0, 100, 0, 0)),
      stroke('b', run(5_000, 5_100, 5_000, 200)),
    ];
    expect(groupStrokes(strokes)).toHaveLength(2);
  });

  it('merges a group in draw order, so a four-stroke box reads as a box', () => {
    const box: InkStroke[] = [
      stroke('top', run(0, 200, 0, 0)),
      stroke('right', Array.from({ length: 60 }, (_, i) => ({ x: 200, y: i * 2.5, pressure: 0.5, t: 300 + i }))),
      stroke('bottom', Array.from({ length: 80 }, (_, i) => ({ x: 200 - i * 2.5, y: 150, pressure: 0.5, t: 600 + i }))),
      stroke('left', Array.from({ length: 60 }, (_, i) => ({ x: 0, y: 150 - i * 2.5, pressure: 0.5, t: 900 + i }))),
    ];
    const groups = groupStrokes(box);
    expect(groups).toHaveLength(1);

    const merged = mergeGroup(groups[0] as { strokes: InkStroke[]; box: never; lastLiftAt: number });
    expect(recognizeShape(merged).kind).toBe('rectangle');
  });
});

describe('recognition timing (PRD Appendix C.1)', () => {
  it('fires 300ms after the pen lifts, not before', () => {
    const scheduler = new RecognitionScheduler<string>();
    scheduler.touch('group-1', 1_000);

    expect(scheduler.due(1_000 + RECOGNITION_DELAY_MS - 1)).toEqual([]);
    expect(scheduler.due(1_000 + RECOGNITION_DELAY_MS)).toEqual(['group-1']);
    // Fires once, then the countdown is spent.
    expect(scheduler.due(9_999)).toEqual([]);
  });

  it('restarts the countdown while the analyst is still drawing the group', () => {
    const scheduler = new RecognitionScheduler<string>();
    scheduler.touch('group-1', 0);
    scheduler.touch('group-1', 200);
    expect(scheduler.due(310)).toEqual([]);
    expect(scheduler.due(500)).toEqual(['group-1']);
  });

  it('tracks groups independently and can be cancelled', () => {
    const scheduler = new RecognitionScheduler<string>();
    scheduler.touch('a', 0);
    scheduler.touch('b', 100);
    scheduler.cancel('a');
    expect(scheduler.size).toBe(1);
    expect(scheduler.due(500)).toEqual(['b']);
  });
});

describe('grouping measures hesitation, not drawing time', () => {
  function timed(id: string, points: Array<{ x: number; y: number }>, t0: number, perPoint: number): InkStroke {
    return {
      id,
      runs: [{ points: points.map((p, i) => ({ ...p, pressure: 0.5, t: t0 + i * perPoint })) }],
      committed: true,
    };
  }

  it('keeps a group together when one of its strokes is slow to draw', () => {
    // Two edges of a box. The second takes 3 seconds to draw, but the pen went
    // down 40ms after the first lifted: that is one shape, drawn carefully.
    const first = timed('top', [{ x: 0, y: 0 }, { x: 200, y: 0 }], 0, 100);
    const firstLift = 100;
    const second = timed(
      'right',
      Array.from({ length: 60 }, (_, i) => ({ x: 200, y: i * 2 })),
      firstLift + 40,
      50,
    );
    expect(groupStrokes([first, second])).toHaveLength(1);
  });

  it('still splits when the hand actually stopped', () => {
    const first = timed('a', [{ x: 0, y: 0 }, { x: 200, y: 0 }], 0, 100);
    const second = timed('b', [{ x: 0, y: 10 }, { x: 200, y: 10 }], 100 + GROUP_GAP_MS + 1, 100);
    expect(groupStrokes([first, second])).toHaveLength(2);
  });
});
