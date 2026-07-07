import { create } from 'zustand';
import {
  applyScenePatch,
  createInitialScene,
  type Layer,
  type PatchOp,
  type SceneState,
  type Selection,
  type Viewport,
} from '@geoglobe/scene-schema';

/**
 * The Scene State store — the single source of truth on the client (ARCHITECTURE §5).
 * The globe renders from `scene`; nothing draws from ad-hoc component state.
 *
 * Two mutation paths, by design:
 *  - `setViewport`: a fast, direct camera update (fires up to 60x/s from orbit + spin),
 *    so it skips full-scene schema validation on the hot path.
 *  - `applyPatch`: the validated RFC 6902 chokepoint for structural changes. The Layer
 *    panel and (later) the LLM agent edit layers/selection/time through this.
 */
const BASE = import.meta.env.BASE_URL;

const DEMO_LAYERS: Layer[] = [
  {
    id: 'countries',
    type: 'geojson',
    source: { kind: 'geojson', url: `${BASE}data/countries.geojson` },
    encoding: { fill: [40, 56, 82, 180], line: [126, 156, 204, 255], lineWidthMinPixels: 0.5 },
    visible: true,
    opacity: 1,
  },
  {
    id: 'cities-points',
    type: 'scatterplot',
    source: { kind: 'json', url: `${BASE}data/cities.json` },
    encoding: {
      position: ['lng', 'lat'],
      radius: 'pop',
      radiusScale: 0.006,
      radiusMinPixels: 1.5,
      radiusMaxPixels: 22,
      color: { field: 'pop', scale: 'plasma', domain: [0, 35_000_000] },
      filterField: 'pop',
      filterRange: [0, 40_000_000],
    },
    visible: true,
    opacity: 0.85,
  },
  {
    // Fed by the Data Service: POST /query/geo (dataset=earthquakes, mag >= 4.5).
    // Resolved client-side by useResolvedData; renders once the backend is reachable.
    id: 'earthquakes',
    type: 'scatterplot',
    source: { kind: 'geo-query', dataset: 'earthquakes', filter: { mag: { gte: 4.5 } } },
    encoding: {
      position: ['lng', 'lat'],
      radius: 'mag',
      radiusScale: 1.6,
      radiusMinPixels: 2,
      radiusMaxPixels: 14,
      color: { field: 'depth', scale: 'magma', domain: [0, 650] },
      timeField: 'time',
    },
    visible: true,
    opacity: 0.9,
  },
  {
    id: 'cities-columns',
    type: 'column',
    source: { kind: 'json', url: `${BASE}data/cities.json` },
    encoding: {
      position: ['lng', 'lat'],
      elevation: 'pop',
      elevationScale: 0.02,
      radiusMeters: 45_000,
      color: { field: 'pop', scale: 'warm', domain: [0, 35_000_000] },
    },
    visible: false,
    opacity: 0.9,
  },
];

function initialScene(): SceneState {
  return applyScenePatch(
    createInitialScene(),
    DEMO_LAYERS.map((layer) => ({ op: 'add', path: '/layers/-', value: layer }) as PatchOp),
  );
}

export interface SceneStore {
  scene: SceneState;
  /** Direct camera update (hot path). */
  setViewport: (viewport: Viewport) => void;
  /** Validated structural mutation. Throws `ScenePatchError` on an invalid patch. */
  applyPatch: (ops: readonly PatchOp[]) => void;
  /** Set (or clear) the current feature selection. */
  select: (selection: Selection) => void;
  /** Replace the entire scene (e.g. load a saved view). Validated. */
  setScene: (scene: SceneState) => void;
}

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: initialScene(),
  setViewport: (viewport) => set((s) => ({ scene: { ...s.scene, viewport } })),
  applyPatch: (ops) => set({ scene: applyScenePatch(get().scene, ops) }),
  select: (selection) =>
    set({
      scene: applyScenePatch(get().scene, [
        { op: 'replace', path: '/selection', value: selection },
      ]),
    }),
  setScene: (scene) => set({ scene }),
}));
