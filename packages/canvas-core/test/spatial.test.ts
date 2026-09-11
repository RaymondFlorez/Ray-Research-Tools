import { describe, expect, it } from 'vitest';
import { RTree } from '../src/spatial.js';
import { rectsIntersect, type Rect } from '../src/viewport.js';

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRects(count: number, seed = 42): Map<string, Rect> {
  const rand = mulberry32(seed);
  const out = new Map<string, Rect>();
  for (let i = 0; i < count; i++) {
    const x = rand() * 100_000 - 50_000;
    const y = rand() * 100_000 - 50_000;
    const w = 40 + rand() * 400;
    const h = 30 + rand() * 300;
    out.set(`n${i}`, { minX: x, minY: y, maxX: x + w, maxY: y + h });
  }
  return out;
}

function bruteForce(rects: Map<string, Rect>, query: Rect): Set<string> {
  const out = new Set<string>();
  for (const [id, rect] of rects) if (rectsIntersect(rect, query)) out.add(id);
  return out;
}

describe('R-tree (PRD 3.1)', () => {
  it('finds exactly what a linear scan finds', () => {
    const rects = makeRects(2_000);
    const tree = new RTree<string>();
    for (const [id, rect] of rects) tree.insert(id, rect);
    expect(tree.size).toBe(2_000);

    const rand = mulberry32(7);
    for (let q = 0; q < 200; q++) {
      const x = rand() * 100_000 - 50_000;
      const y = rand() * 100_000 - 50_000;
      const query: Rect = { minX: x, minY: y, maxX: x + 3_000, maxY: y + 2_000 };
      const got = new Set(tree.search(query));
      expect(got).toEqual(bruteForce(rects, query));
    }
  });

  it('stays correct through interleaved inserts, moves and deletes', () => {
    const rects = makeRects(600, 11);
    const tree = new RTree<string>();
    const live = new Map<string, Rect>();
    for (const [id, rect] of rects) {
      tree.insert(id, rect);
      live.set(id, rect);
    }

    const rand = mulberry32(3);
    const ids = [...rects.keys()];
    for (let step = 0; step < 500; step++) {
      const id = ids[Math.floor(rand() * ids.length)] as string;
      const roll = rand();
      if (roll < 0.4 && live.has(id)) {
        tree.remove(id);
        live.delete(id);
      } else {
        const x = rand() * 100_000 - 50_000;
        const y = rand() * 100_000 - 50_000;
        const rect: Rect = { minX: x, minY: y, maxX: x + 200, maxY: y + 150 };
        // insert() on an existing id reindexes it, which is the move path.
        tree.insert(id, rect);
        live.set(id, rect);
      }
    }

    expect(tree.size).toBe(live.size);
    const query: Rect = { minX: -20_000, minY: -20_000, maxX: 20_000, maxY: 20_000 };
    expect(new Set(tree.search(query))).toEqual(bruteForce(live, query));
  });

  it('reports membership and rectangles, and clears', () => {
    const tree = new RTree<string>();
    tree.insert('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(tree.rectOf('a')).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(tree.intersects({ minX: 5, minY: 5, maxX: 6, maxY: 6 })).toBe(true);
    expect(tree.intersects({ minX: 50, minY: 50, maxX: 60, maxY: 60 })).toBe(false);

    tree.update('a', { minX: 100, minY: 100, maxX: 110, maxY: 110 });
    expect(tree.search({ minX: 0, minY: 0, maxX: 20, maxY: 20 })).toEqual([]);
    expect(tree.search({ minX: 95, minY: 95, maxX: 115, maxY: 115 })).toEqual(['a']);

    expect(tree.remove('a')).toBe(true);
    expect(tree.remove('a')).toBe(false);
    expect(tree.size).toBe(0);
    expect(tree.search({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 })).toEqual([]);

    tree.insert('b', { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    tree.clear();
    expect(tree.size).toBe(0);
  });

  it('answers a viewport query on a 10,000-node canvas well inside the frame budget', () => {
    const rects = makeRects(10_000, 99);
    const tree = new RTree<string>();
    for (const [id, rect] of rects) tree.insert(id, rect);

    const rand = mulberry32(5);
    const queries: Rect[] = [];
    for (let i = 0; i < 200; i++) {
      const x = rand() * 100_000 - 50_000;
      const y = rand() * 100_000 - 50_000;
      queries.push({ minX: x, minY: y, maxX: x + 2_500, maxY: y + 1_600 });
    }

    // Warm up, then measure.
    for (const q of queries) tree.search(q);
    const start = performance.now();
    for (const q of queries) tree.search(q);
    const perQuery = (performance.now() - start) / queries.length;

    // PRD 3.1 budgets 0.5ms. The ceiling here is loose enough not to flake on a
    // shared runner but tight enough to catch a fall back to a linear scan.
    expect(perQuery).toBeLessThan(2);
    expect(new Set(tree.search(queries[0] as Rect))).toEqual(bruteForce(rects, queries[0] as Rect));
  });
});
