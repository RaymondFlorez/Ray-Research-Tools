import { describe, expect, it } from 'vitest';
import { applyScenePatch, createInitialScene, parseScene, ScenePatchError } from './patch';
import type { Layer, SceneState } from './types';

const COUNTRIES: Layer = {
  id: 'countries',
  type: 'geojson',
  source: { kind: 'geojson', url: '/data/countries.geojson' },
  encoding: { fill: [58, 78, 110, 210], line: [126, 156, 204, 255] },
  visible: true,
  opacity: 1,
};

function sceneWithCountries(): SceneState {
  const base = createInitialScene();
  return applyScenePatch(base, [{ op: 'add', path: '/layers/-', value: COUNTRIES }]);
}

describe('createInitialScene / parseScene', () => {
  it('produces a valid scene with schema defaults applied', () => {
    const scene = createInitialScene();
    expect(scene.time).toEqual({ current: null, range: null });
    expect(scene.layers).toEqual([]);
    expect(scene.selection).toBeNull();
    expect(scene.viewport.pitch).toBe(0);
  });

  it('rejects a structurally invalid scene', () => {
    expect(() => parseScene({ viewport: { longitude: 0 } })).toThrow();
  });
});

describe('applyScenePatch — valid patches', () => {
  it('replaces a viewport field and returns a new scene', () => {
    const scene = createInitialScene();
    const next = applyScenePatch(scene, [{ op: 'replace', path: '/viewport/zoom', value: 4 }]);
    expect(next.viewport.zoom).toBe(4);
  });

  it('adds a layer', () => {
    const next = sceneWithCountries();
    expect(next.layers).toHaveLength(1);
    expect(next.layers[0].id).toBe('countries');
  });

  it('toggles layer visibility', () => {
    const scene = sceneWithCountries();
    const next = applyScenePatch(scene, [
      { op: 'replace', path: '/layers/0/visible', value: false },
    ]);
    expect(next.layers[0].visible).toBe(false);
  });

  it('does NOT mutate the input scene (immutability)', () => {
    const scene = sceneWithCountries();
    const snapshot = structuredClone(scene);
    applyScenePatch(scene, [{ op: 'replace', path: '/layers/0/opacity', value: 0.2 }]);
    expect(scene).toEqual(snapshot);
  });
});

describe('applyScenePatch — rejected patches', () => {
  it('rejects a malformed operation (missing path)', () => {
    const scene = createInitialScene();
    // @ts-expect-error intentionally malformed op for the test
    expect(() => applyScenePatch(scene, [{ op: 'replace', value: 1 }])).toThrow(ScenePatchError);
  });

  it('rejects an unknown op name', () => {
    const scene = createInitialScene();
    // @ts-expect-error intentionally invalid op name
    expect(() => applyScenePatch(scene, [{ op: 'frobnicate', path: '/viewport' }])).toThrow(
      ScenePatchError,
    );
  });

  it('rejects a patch that violates the schema (opacity out of range)', () => {
    const scene = sceneWithCountries();
    let err: unknown;
    try {
      applyScenePatch(scene, [{ op: 'replace', path: '/layers/0/opacity', value: 5 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScenePatchError);
    expect((err as ScenePatchError).kind).toBe('schema');
  });

  it('rejects a patch that violates the schema (latitude off-globe)', () => {
    const scene = createInitialScene();
    expect(() =>
      applyScenePatch(scene, [{ op: 'replace', path: '/viewport/latitude', value: 200 }]),
    ).toThrow(ScenePatchError);
  });

  it('rejects removing a required field', () => {
    const scene = createInitialScene();
    expect(() => applyScenePatch(scene, [{ op: 'remove', path: '/viewport' }])).toThrow(
      ScenePatchError,
    );
  });
});
