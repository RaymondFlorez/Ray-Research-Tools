import type { Viewport } from '@geoglobe/scene-schema';
import type { GlobeViewState } from './types';

/**
 * Maps the Scene State camera to the engine-agnostic view state. Data-layer translation
 * now lives in `@geoglobe/layer-adapters` (consumed inside each renderer), so this file
 * only bridges the viewport.
 */
export function viewportToViewState(viewport: Viewport): GlobeViewState {
  return {
    longitude: viewport.longitude,
    latitude: viewport.latitude,
    zoom: viewport.zoom,
    pitch: viewport.pitch,
    bearing: viewport.bearing,
  };
}
