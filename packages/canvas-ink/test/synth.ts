/**
 * Synthetic stroke generator.
 *
 * The Phase 5 exit criterion is shape recognition accuracy above 92 percent on
 * an internal set. Until there is a captured set from real analysts, this
 * generates one: strokes with the imperfections a hand actually produces —
 * jitter, wobble, overshoot past a corner, loops that do not quite close,
 * rotation, and non-uniform sampling speed. A generator that draws perfect
 * shapes would prove nothing.
 */

import type { Vec2 } from '@picasso/canvas-core';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

/** Uniform in [-1, 1]. */
function signed(rand: Rand): number {
  return rand() * 2 - 1;
}

function rotate(p: Vec2, angle: number, about: Vec2): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

export interface HandOptions {
  /** Perpendicular wobble as a fraction of the shape's size. */
  jitter?: number;
  /** Samples per unit length; a real stylus oversamples slow passages. */
  density?: number;
}

/**
 * Hand tremor is low-frequency, not per-sample noise: a hand drifts across a
 * line over tens of milliseconds, it does not jump between consecutive stylus
 * samples. Modelling it as white noise would put a corner between every pair of
 * samples and would not resemble ink at all, so the wobble here is a sum of two
 * slow sinusoids with random phase.
 */
function tremor(rand: Rand, amplitude: number): (t: number) => number {
  const phaseA = rand() * Math.PI * 2;
  const phaseB = rand() * Math.PI * 2;
  const freqA = 1 + rand() * 1.5;
  const freqB = 2.5 + rand() * 3;
  const weightB = 0.25 + rand() * 0.25;
  return (t: number) =>
    amplitude *
    (Math.sin(t * Math.PI * freqA + phaseA) * (1 - weightB) +
      Math.sin(t * Math.PI * freqB + phaseB) * weightB);
}

/**
 * Walks a polyline, adding samples with hand wobble. Sampling density varies
 * along the path, which is what a real capture looks like.
 */
function handDraw(
  vertices: readonly Vec2[],
  rand: Rand,
  scale: number,
  options: HandOptions = {},
): Vec2[] {
  const { jitter = 0.012, density = 0.55 } = options;
  const out: Vec2[] = [];
  const amplitude = scale * jitter;

  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1] as Vec2;
    const b = vertices[i] as Vec2;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    // Vary speed segment to segment, as a hand does.
    const steps = Math.max(2, Math.round(length * density * (0.6 + rand() * 0.9)));
    const nx = length === 0 ? 0 : -(b.y - a.y) / length;
    const ny = length === 0 ? 0 : (b.x - a.x) / length;
    const wobble = tremor(rand, amplitude);

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const offset = wobble(t);
      out.push({
        x: a.x + (b.x - a.x) * t + nx * offset,
        y: a.y + (b.y - a.y) * t + ny * offset,
      });
    }
  }
  out.push({ ...(vertices[vertices.length - 1] as Vec2) });
  return out;
}

export function makeLine(rand: Rand): Vec2[] {
  const length = 120 + rand() * 400;
  const angle = rand() * Math.PI * 2;
  const start = { x: rand() * 200, y: rand() * 200 };
  const end = { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
  return handDraw([start, end], rand, length, { jitter: 0.008 + rand() * 0.012 });
}

export function makeRectangle(rand: Rand): Vec2[] {
  const w = 90 + rand() * 320;
  const h = 70 + rand() * 260;
  const x = rand() * 200;
  const y = rand() * 200;
  // People draw boxes close to axis-aligned, but not exactly.
  const tilt = signed(rand) * 0.08;
  const centre = { x: x + w / 2, y: y + h / 2 };

  const corners: Vec2[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  // Start anywhere on the loop, as a hand does.
  const offset = Math.floor(rand() * 4);
  const ordered = [...corners.slice(offset), ...corners.slice(0, offset)];

  // Close the loop, either short of the start or overshooting past it.
  const closeError = signed(rand) * 0.12;
  const first = ordered[0] as Vec2;
  const second = ordered[1] as Vec2;
  const closing = {
    x: first.x + (second.x - first.x) * closeError,
    y: first.y + (second.y - first.y) * closeError,
  };

  const path = [...ordered, closing].map((p) => rotate(p, tilt, centre));
  return handDraw(path, rand, Math.max(w, h), { jitter: 0.008 + rand() * 0.014 });
}

export function makeEllipse(rand: Rand): Vec2[] {
  const rx = 50 + rand() * 180;
  const ry = 40 + rand() * 150;
  const cx = rand() * 200;
  const cy = rand() * 200;
  const tilt = rand() * Math.PI;
  const start = rand() * Math.PI * 2;
  // Sweep a little under or over a full turn: hand-drawn loops rarely close.
  const sweep = Math.PI * 2 * (0.9 + rand() * 0.16);
  const direction = rand() < 0.5 ? 1 : -1;

  const steps = 40 + Math.floor(rand() * 40);
  const points: Vec2[] = [];
  // Slow radius wobble, so it is not a perfect conic.
  const wobbleFreq = 1.5 + rand() * 2;
  const wobblePhase = rand() * Math.PI * 2;
  const wobbleAmount = 0.02 + rand() * 0.035;
  for (let i = 0; i <= steps; i++) {
    const t = start + direction * sweep * (i / steps);
    const wobble = 1 + Math.sin(t * wobbleFreq + wobblePhase) * wobbleAmount;
    const p = { x: cx + Math.cos(t) * rx * wobble, y: cy + Math.sin(t) * ry * wobble };
    points.push(rotate(p, tilt, { x: cx, y: cy }));
  }
  return points;
}

export function makeArrow(rand: Rand): Vec2[] {
  const length = 140 + rand() * 320;
  const angle = rand() * Math.PI * 2;
  const start = { x: rand() * 200, y: rand() * 200 };
  const tip = {
    x: start.x + Math.cos(angle) * length,
    y: start.y + Math.sin(angle) * length,
  };

  const barbLength = length * (0.16 + rand() * 0.12);
  const spread = 0.45 + rand() * 0.35;
  const barb = (side: number): Vec2 => ({
    x: tip.x - Math.cos(angle + side * spread) * barbLength,
    y: tip.y - Math.sin(angle + side * spread) * barbLength,
  });

  // Two ways people draw an arrow in one stroke: retrace the barbs from the
  // tip, or run through the head in a V.
  const path =
    rand() < 0.6
      ? [start, tip, barb(1), tip, barb(-1)]
      : [start, tip, barb(1), barb(-1)];

  return handDraw(path, rand, length, { jitter: 0.006 + rand() * 0.01 });
}

export function makeBracket(rand: Rand): Vec2[] {
  const spine = 120 + rand() * 260;
  const arm = spine * (0.18 + rand() * 0.22);
  const x = rand() * 200;
  const y = rand() * 200;
  const facing = rand() < 0.5 ? 1 : -1;
  const tilt = signed(rand) * 0.12;
  const centre = { x, y: y + spine / 2 };

  const path: Vec2[] = [
    { x: x + facing * arm, y },
    { x, y },
    { x, y: y + spine },
    { x: x + facing * arm, y: y + spine },
  ];
  return handDraw(
    path.map((p) => rotate(p, tilt, centre)),
    rand,
    spine,
    { jitter: 0.008 + rand() * 0.012 },
  );
}

/**
 * The negative class. A scribble, a word, or a squiggle must not be confidently
 * recognized as anything: the ambient promote affordance keys off confidence,
 * so a false positive here puts an unwanted offer on the canvas.
 */
export function makeScribble(rand: Rand): Vec2[] {
  const kind = rand();
  const x = rand() * 200;
  const y = rand() * 200;

  if (kind < 0.4) {
    // A zigzag, like crossed-out text.
    const runs = 4 + Math.floor(rand() * 6);
    const width = 140 + rand() * 200;
    const height = 30 + rand() * 60;
    const path: Vec2[] = [];
    for (let i = 0; i <= runs; i++) {
      path.push({ x: x + (width * i) / runs, y: y + (i % 2 === 0 ? 0 : height) });
    }
    return handDraw(path, rand, width, { jitter: 0.03 });
  }

  if (kind < 0.7) {
    // A loopy squiggle, like cursive.
    const steps = 60 + Math.floor(rand() * 60);
    const width = 150 + rand() * 220;
    const points: Vec2[] = [];
    const loops = 2.5 + rand() * 3;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({
        x: x + width * t + Math.cos(t * Math.PI * 2 * loops) * 14,
        y: y + Math.sin(t * Math.PI * 2 * loops) * (24 + rand() * 10),
      });
    }
    return points;
  }

  // A random walk.
  const steps = 40 + Math.floor(rand() * 60);
  const points: Vec2[] = [{ x, y }];
  let angle = rand() * Math.PI * 2;
  for (let i = 0; i < steps; i++) {
    angle += signed(rand) * 1.1;
    const step = 6 + rand() * 18;
    const previous = points[points.length - 1] as Vec2;
    points.push({ x: previous.x + Math.cos(angle) * step, y: previous.y + Math.sin(angle) * step });
  }
  return points;
}

export const GENERATORS = {
  line: makeLine,
  rectangle: makeRectangle,
  ellipse: makeEllipse,
  arrow: makeArrow,
  bracket: makeBracket,
} as const;

export type SynthShape = keyof typeof GENERATORS;

export interface Sample {
  expected: SynthShape;
  points: Vec2[];
}

/** A labelled set: `perClass` strokes of each shape. */
export function buildSet(perClass: number, seed = 1): Sample[] {
  const rand = mulberry32(seed);
  const out: Sample[] = [];
  for (const [expected, make] of Object.entries(GENERATORS) as Array<
    [SynthShape, (r: Rand) => Vec2[]]
  >) {
    for (let i = 0; i < perClass; i++) out.push({ expected, points: make(rand) });
  }
  return out;
}

export function buildScribbles(count: number, seed = 2): Vec2[][] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => makeScribble(rand));
}
