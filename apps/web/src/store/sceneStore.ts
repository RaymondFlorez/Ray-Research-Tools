import { create } from 'zustand';
import {
  applyScenePatch,
  createInitialScene,
  type Layer,
  type PatchOp,
  type SceneState,
  type Viewport,
} from '@geoglobe/scene-schema';

/**
 * The Scene State store — the single source of truth on the client (ARCHITECTURE §5).
 * The globe renders from `scene`; nothing draws from ad-hoc component state.
 *
 * Two mutation paths, by design:
 *  - `setViewport`: a fast, direct camera update (fires up to 60x/s from orbit + spin),
 *    so it skips full-scene schema validation on the hot path.
 *  - `applyPatch`: the validated RFC 6902 chokepoint for structural changes. This is
 *    what the UI (Step 4) and the LLM agent (Step 7) use to edit layers/selection/time.
 */
const COUNTRIES_LAYER: Layer = {
  id: 'countries',
  type: 'geojson',
  source: { kind: 'geojson', url: `${import.meta.env.BASE_URL}data/countries.geojson` },
  encoding: {
    fill: [58, 78, 110, 210],
    line: [126, 156, 204, 255],
    lineWidthMinPixels: 0.5,
  },
  visible: true,
  opacity: 1,
};

function initialScene(): SceneState {
  // Start from the default scene and add the one MVP data layer via the validated path.
  return applyScenePatch(createInitialScene(), [
    { op: 'add', path: '/layers/-', value: COUNTRIES_LAYER },
  ]);
}

export interface SceneStore {
  scene: SceneState;
  /** Direct camera update (hot path). */
  setViewport: (viewport: Viewport) => void;
  /** Validated structural mutation. Throws `ScenePatchError` on an invalid patch. */
  applyPatch: (ops: readonly PatchOp[]) => void;
  /** Replace the entire scene (e.g. load a saved view). Validated. */
  setScene: (scene: SceneState) => void;
}

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: initialScene(),
  setViewport: (viewport) => set((s) => ({ scene: { ...s.scene, viewport } })),
  applyPatch: (ops) => set({ scene: applyScenePatch(get().scene, ops) }),
  setScene: (scene) => set({ scene }),
}));
