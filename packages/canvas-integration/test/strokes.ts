/**
 * Hand-drawn strokes, generated here rather than imported.
 *
 * `canvas-ink` has richer generators in its own test folder, but reaching into
 * another package's tests crosses a boundary this package should respect: the
 * integration suite consumes published surfaces, the same as any other caller
 * would. These are deliberately simple — a wobble and a slightly-missed close,
 * which is all the recognizer needs to be doing real work rather than reading
 * a machine-perfect polygon.
 */

import type { Vec2 } from '@picasso/canvas-core';

/** Deterministic, so a recognizer regression shows up as a failure and not a flake. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Low-frequency wobble, which is closer to a hand than white noise. */
function wobble(rand: () => number, amplitude: number): (t: number) => number {
  const phase = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  return (t) => amplitude * (Math.sin(t * 3 + phase) * 0.6 + Math.sin(t * 7 + phase2) * 0.4);
}

function along(a: Vec2, b: Vec2, steps: number, jitter: (t: number) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const nx = b.y - a.y;
    const ny = -(b.x - a.x);
    const length = Math.hypot(nx, ny) || 1;
    const push = jitter(t);
    out.push({
      x: a.x + (b.x - a.x) * t + (nx / length) * push,
      y: a.y + (b.y - a.y) * t + (ny / length) * push,
    });
  }
  return out;
}

/** A box drawn in one stroke, closing a little short of where it started. */
export function handDrawnBox(rand: () => number, w = 360, h = 240): Vec2[] {
  const x = 100 + rand() * 20;
  const y = 200 + rand() * 20;
  const corners: Vec2[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    // Closes 4px short: nobody lands exactly on their own start.
    { x: x + 4, y: y + 3 },
  ];
  const points: Vec2[] = [];
  for (let i = 0; i < corners.length - 1; i += 1) {
    const segment = along(corners[i]!, corners[i + 1]!, 14, wobble(rand, 1.6));
    points.push(...(i === 0 ? segment : segment.slice(1)));
  }
  return points;
}

export function handDrawnEllipse(rand: () => number, rx = 120, ry = 70): Vec2[] {
  const cx = 300 + rand() * 20;
  const cy = 260 + rand() * 20;
  const noise = wobble(rand, 2.2);
  const points: Vec2[] = [];
  const steps = 72;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = t * Math.PI * 2;
    const push = noise(t);
    points.push({
      x: cx + (rx + push) * Math.cos(angle),
      y: cy + (ry + push) * Math.sin(angle),
    });
  }
  return points;
}

/** A crossing-out scribble: no shape at all, which is the point. */
export function scribble(rand: () => number): Vec2[] {
  const points: Vec2[] = [];
  let x = 120;
  let y = 300;
  for (let i = 0; i < 90; i += 1) {
    x += 6 + rand() * 6;
    y += (rand() - 0.5) * 70;
    points.push({ x, y });
    if (i % 12 === 11) x -= 28 + rand() * 18;
  }
  return points;
}
