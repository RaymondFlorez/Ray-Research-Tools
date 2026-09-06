import { describe, expect, it } from 'vitest';
import { LOD_DEBOUNCE_MS, type LOD } from '@picasso/canvas-core';
import { DOM_LOD_FLOOR, DomMountManager } from '../src/mount.js';

const at = (lod: LOD, visible = true) => [{ id: 'a', lod, visible }];

describe('DOM mount lifecycle (PRD 3.1)', () => {
  it('mounts nothing below LOD2', () => {
    const m = new DomMountManager();
    expect(m.update(at(0), 0).mounted.size).toBe(0);
    expect(m.update(at(1), 10).mounted.size).toBe(0);
    expect(DOM_LOD_FLOOR).toBe(2);
  });

  it('mounts a newly visible node immediately', () => {
    const m = new DomMountManager();
    const diff = m.update(at(2), 0);
    expect(diff.added).toEqual(['a']);
    expect([...diff.mounted]).toEqual(['a']);
  });

  it('debounces an LOD crossing by 120ms in both directions', () => {
    const m = new DomMountManager();
    m.update(at(2), 0);

    // Zoom out across the LOD2/LOD1 boundary: nothing unmounts yet.
    expect(m.update(at(1), 10).removed).toEqual([]);
    expect(m.update(at(1), 10 + LOD_DEBOUNCE_MS - 1).removed).toEqual([]);
    expect(m.update(at(1), 10 + LOD_DEBOUNCE_MS).removed).toEqual(['a']);
    expect(m.mounted.size).toBe(0);

    // And back in.
    expect(m.update(at(2), 200).added).toEqual([]);
    expect(m.update(at(2), 200 + LOD_DEBOUNCE_MS).added).toEqual(['a']);
  });

  it('never commits a crossing the analyst scrolled straight through', () => {
    const m = new DomMountManager();
    m.update(at(2), 0);
    // A fast wheel zoom: LOD1 for 40ms, LOD0 for 40ms, back to LOD2.
    m.update(at(1), 20);
    m.update(at(0), 60);
    m.update(at(2), 100);
    m.update(at(2), 400);
    expect([...m.mounted]).toEqual(['a']);
  });

  it('mounts and unmounts on a pan immediately, without waiting out the debounce', () => {
    const m = new DomMountManager();
    m.update(at(2), 0);

    // Scrolled out of the cull rect: gone now, not in 120ms.
    const off = m.update([{ id: 'a', lod: 2, visible: false }], 5);
    expect(off.removed).toEqual(['a']);
    expect(off.mounted.size).toBe(0);

    const back = m.update(at(2), 10);
    expect(back.added).toEqual(['a']);
  });

  it('drops a node that disappeared from the candidate list entirely', () => {
    const m = new DomMountManager();
    m.update(at(2), 0);
    const diff = m.update([], 5);
    expect(diff.removed).toEqual(['a']);
    expect(diff.mounted.size).toBe(0);

    // And forgets it, so it mounts fresh rather than resuming a stale debounce.
    expect(m.update(at(2), 6).added).toEqual(['a']);
  });

  it('tracks many nodes independently', () => {
    const m = new DomMountManager();
    m.update(
      [
        { id: 'a', lod: 2, visible: true },
        { id: 'b', lod: 1, visible: true },
        { id: 'c', lod: 3, visible: true },
      ],
      0,
    );
    expect(new Set(m.mounted)).toEqual(new Set(['a', 'c']));

    m.update(
      [
        { id: 'a', lod: 1, visible: true },
        { id: 'b', lod: 2, visible: true },
        { id: 'c', lod: 3, visible: true },
      ],
      10,
    );
    // Both crossings are still pending.
    expect(new Set(m.mounted)).toEqual(new Set(['a', 'c']));

    m.update(
      [
        { id: 'a', lod: 1, visible: true },
        { id: 'b', lod: 2, visible: true },
        { id: 'c', lod: 3, visible: true },
      ],
      10 + LOD_DEBOUNCE_MS,
    );
    expect(new Set(m.mounted)).toEqual(new Set(['b', 'c']));
  });

  it('resets cleanly', () => {
    const m = new DomMountManager();
    m.update(at(2), 0);
    m.reset();
    expect(m.mounted.size).toBe(0);
  });
});
