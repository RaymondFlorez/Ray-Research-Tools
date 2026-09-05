/**
 * R-tree spatial index (PRD 3.1).
 *
 * "Spatial queries run against an in-memory R-tree (rbush) rebuilt
 * incrementally on node move and resize." Insert uses least-enlargement subtree
 * choice; overflow uses Guttman's quadratic split; delete condenses the tree and
 * reinserts orphaned entries. Queries are the renderer's hot path, so `search`
 * allocates only the result array.
 */

import type { Rect } from './viewport.js';
import { enlargement, rectArea, rectContains, rectsIntersect, unionRect } from './viewport.js';

const MAX_ENTRIES = 9;
const MIN_ENTRIES = Math.max(2, Math.ceil(MAX_ENTRIES * 0.4));

interface Entry<T> {
  rect: Rect;
  /** Set on leaf entries. */
  id?: T;
  /** Set on internal entries. */
  child?: RNode<T>;
}

interface RNode<T> {
  rect: Rect;
  leaf: boolean;
  entries: Entry<T>[];
}

function emptyRect(): Rect {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function coverRect<T>(entries: readonly Entry<T>[]): Rect {
  let r = emptyRect();
  for (const e of entries) r = unionRect(r, e.rect);
  return r;
}

function newNode<T>(leaf: boolean): RNode<T> {
  return { rect: emptyRect(), leaf, entries: [] };
}

export class RTree<T> {
  private root: RNode<T> = newNode<T>(true);
  private rects = new Map<T, Rect>();

  get size(): number {
    return this.rects.size;
  }

  /** The rectangle currently indexed for `id`, if any. */
  rectOf(id: T): Rect | undefined {
    return this.rects.get(id);
  }

  insert(id: T, rect: Rect): void {
    if (this.rects.has(id)) {
      this.update(id, rect);
      return;
    }
    this.rects.set(id, rect);
    this.insertEntry({ rect, id }, this.root, []);
  }

  /** Incremental reindex on move or resize. */
  update(id: T, rect: Rect): void {
    const current = this.rects.get(id);
    if (current === undefined) {
      this.insert(id, rect);
      return;
    }
    if (
      current.minX === rect.minX &&
      current.minY === rect.minY &&
      current.maxX === rect.maxX &&
      current.maxY === rect.maxY
    ) {
      return;
    }
    this.remove(id);
    this.insert(id, rect);
  }

  remove(id: T): boolean {
    const rect = this.rects.get(id);
    if (rect === undefined) return false;
    this.rects.delete(id);

    const path: RNode<T>[] = [];
    const indexPath: number[] = [];
    const removed = this.findAndRemove(this.root, rect, id, path, indexPath);
    if (!removed) return false;
    this.condense(path, indexPath);
    return true;
  }

  clear(): void {
    this.root = newNode<T>(true);
    this.rects.clear();
  }

  /** All ids whose rectangle intersects `rect`. */
  search(rect: Rect): T[] {
    const out: T[] = [];
    if (this.rects.size === 0) return out;
    const stack: RNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop() as RNode<T>;
      if (!rectsIntersect(node.rect, rect) && node !== this.root) continue;
      for (const e of node.entries) {
        if (!rectsIntersect(e.rect, rect)) continue;
        if (node.leaf) {
          out.push(e.id as T);
        } else if (rectContains(rect, e.rect)) {
          collectAll(e.child as RNode<T>, out);
        } else {
          stack.push(e.child as RNode<T>);
        }
      }
    }
    return out;
  }

  /** True if anything at all intersects `rect`. Cheaper than `search`. */
  intersects(rect: Rect): boolean {
    const stack: RNode<T>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop() as RNode<T>;
      for (const e of node.entries) {
        if (!rectsIntersect(e.rect, rect)) continue;
        if (node.leaf) return true;
        stack.push(e.child as RNode<T>);
      }
    }
    return false;
  }

  private insertEntry(entry: Entry<T>, start: RNode<T>, path: RNode<T>[]): void {
    let node = start;
    path.push(node);
    while (!node.leaf) {
      const next = chooseSubtree(node, entry.rect);
      node = next;
      path.push(node);
    }
    node.entries.push(entry);
    node.rect = unionRect(node.rect, entry.rect);

    // Split upward while nodes overflow.
    for (let i = path.length - 1; i >= 0; i--) {
      const current = path[i] as RNode<T>;
      if (current.entries.length <= MAX_ENTRIES) break;
      const split = quadraticSplit(current);
      if (i === 0) {
        const root = newNode<T>(false);
        root.entries = [
          { rect: current.rect, child: current },
          { rect: split.rect, child: split },
        ];
        root.rect = coverRect(root.entries);
        this.root = root;
      } else {
        const parent = path[i - 1] as RNode<T>;
        const slot = parent.entries.find((e) => e.child === current);
        if (slot) slot.rect = current.rect;
        parent.entries.push({ rect: split.rect, child: split });
        parent.rect = coverRect(parent.entries);
      }
    }

    // Tighten covering rectangles along the insertion path.
    for (let i = path.length - 1; i > 0; i--) {
      const current = path[i] as RNode<T>;
      const parent = path[i - 1] as RNode<T>;
      const slot = parent.entries.find((e) => e.child === current);
      if (slot) slot.rect = current.rect;
      parent.rect = coverRect(parent.entries);
    }
  }

  private findAndRemove(
    node: RNode<T>,
    rect: Rect,
    id: T,
    path: RNode<T>[],
    indexPath: number[],
  ): boolean {
    path.push(node);
    if (node.leaf) {
      const idx = node.entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        path.pop();
        return false;
      }
      node.entries.splice(idx, 1);
      return true;
    }
    for (let i = 0; i < node.entries.length; i++) {
      const e = node.entries[i] as Entry<T>;
      if (!rectsIntersect(e.rect, rect)) continue;
      indexPath.push(i);
      if (this.findAndRemove(e.child as RNode<T>, rect, id, path, indexPath)) return true;
      indexPath.pop();
    }
    path.pop();
    return false;
  }

  /** Guttman condense: drop underfull nodes and reinsert their entries. */
  private condense(path: RNode<T>[], indexPath: number[]): void {
    const orphans: Entry<T>[] = [];
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i] as RNode<T>;
      if (i > 0 && node.entries.length < MIN_ENTRIES) {
        const parent = path[i - 1] as RNode<T>;
        const idx = indexPath[i - 1] as number;
        parent.entries.splice(idx, 1);
        orphans.push(...node.entries.map((e) => ({ ...e })));
      } else {
        node.rect = node.entries.length > 0 ? coverRect(node.entries) : emptyRect();
      }
    }

    // Collapse a root left with a single child.
    while (!this.root.leaf && this.root.entries.length === 1) {
      this.root = (this.root.entries[0] as Entry<T>).child as RNode<T>;
    }
    if (this.root.entries.length === 0) this.root.rect = emptyRect();

    for (const orphan of orphans) {
      if (orphan.child) {
        const leaves: Entry<T>[] = [];
        collectEntries(orphan.child, leaves);
        for (const leaf of leaves) this.insertEntry(leaf, this.root, []);
      } else {
        this.insertEntry(orphan, this.root, []);
      }
    }
  }
}

function collectAll<T>(node: RNode<T>, out: T[]): void {
  if (node.leaf) {
    for (const e of node.entries) out.push(e.id as T);
    return;
  }
  for (const e of node.entries) collectAll(e.child as RNode<T>, out);
}

function collectEntries<T>(node: RNode<T>, out: Entry<T>[]): void {
  if (node.leaf) {
    for (const e of node.entries) out.push({ ...e });
    return;
  }
  for (const e of node.entries) collectEntries(e.child as RNode<T>, out);
}

/** Least enlargement, ties broken by least area. */
function chooseSubtree<T>(node: RNode<T>, rect: Rect): RNode<T> {
  let best: Entry<T> | undefined;
  let bestEnlargement = Infinity;
  let bestArea = Infinity;
  for (const e of node.entries) {
    const grow = enlargement(e.rect, rect);
    const area = rectArea(e.rect);
    if (grow < bestEnlargement || (grow === bestEnlargement && area < bestArea)) {
      best = e;
      bestEnlargement = grow;
      bestArea = area;
    }
  }
  return (best as Entry<T>).child as RNode<T>;
}

/** Guttman's quadratic split. Returns the new sibling; `node` keeps group one. */
function quadraticSplit<T>(node: RNode<T>): RNode<T> {
  const entries = node.entries;
  const [seedA, seedB] = pickSeeds(entries);
  const groupA: Entry<T>[] = [entries[seedA] as Entry<T>];
  const groupB: Entry<T>[] = [entries[seedB] as Entry<T>];
  const rest = entries.filter((_, i) => i !== seedA && i !== seedB);

  let rectA = groupA[0]!.rect;
  let rectB = groupB[0]!.rect;

  while (rest.length > 0) {
    // Force-fill whichever group would otherwise drop below the minimum.
    if (groupA.length + rest.length === MIN_ENTRIES) {
      for (const e of rest) {
        groupA.push(e);
        rectA = unionRect(rectA, e.rect);
      }
      break;
    }
    if (groupB.length + rest.length === MIN_ENTRIES) {
      for (const e of rest) {
        groupB.push(e);
        rectB = unionRect(rectB, e.rect);
      }
      break;
    }

    // Pick the entry with the strongest preference, assign it there.
    let pickIndex = 0;
    let bestDiff = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const e = rest[i] as Entry<T>;
      const diff = Math.abs(enlargement(rectA, e.rect) - enlargement(rectB, e.rect));
      if (diff > bestDiff) {
        bestDiff = diff;
        pickIndex = i;
      }
    }
    const picked = rest.splice(pickIndex, 1)[0] as Entry<T>;
    const growA = enlargement(rectA, picked.rect);
    const growB = enlargement(rectB, picked.rect);
    const toA =
      growA < growB ||
      (growA === growB && (rectArea(rectA) < rectArea(rectB) || groupA.length < groupB.length));
    if (toA) {
      groupA.push(picked);
      rectA = unionRect(rectA, picked.rect);
    } else {
      groupB.push(picked);
      rectB = unionRect(rectB, picked.rect);
    }
  }

  node.entries = groupA;
  node.rect = rectA;
  const sibling = newNode<T>(node.leaf);
  sibling.entries = groupB;
  sibling.rect = rectB;
  return sibling;
}

/** The two entries that would waste the most area if grouped together. */
function pickSeeds<T>(entries: readonly Entry<T>[]): [number, number] {
  let worst = -Infinity;
  let pair: [number, number] = [0, 1];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i] as Entry<T>;
      const b = entries[j] as Entry<T>;
      const waste = rectArea(unionRect(a.rect, b.rect)) - rectArea(a.rect) - rectArea(b.rect);
      if (waste > worst) {
        worst = waste;
        pair = [i, j];
      }
    }
  }
  return pair;
}
