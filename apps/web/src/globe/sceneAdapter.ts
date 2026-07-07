import type { Layer, SceneState, Viewport } from '@geoglobe/scene-schema';
import type { GlobeLayerSpec, GlobeViewState } from './types';

/**
 * Translates canonical Scene State into the engine-agnostic globe inputs. This is the
 * one place that knows how a stored `Layer` becomes a drawable `GlobeLayerSpec`; the
 * renderer stays ignorant of Scene State, and Scene State stays ignorant of deck.gl.
 *
 * Step 4 (@geoglobe/layer-adapters) grows this to cover every layer/source kind; for
 * now it handles the MVP's static-GeoJSON layers.
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

/** Fold a layer's opacity into an RGBA color's alpha channel. */
function withOpacity(
  color: [number, number, number, number],
  opacity: number,
): [number, number, number, number] {
  return [color[0], color[1], color[2], Math.round(color[3] * opacity)];
}

function layerToSpec(layer: Layer): GlobeLayerSpec | null {
  if (!layer.visible) return null;

  if (layer.source.kind === 'geojson') {
    const fill = layer.encoding.fill ?? [58, 78, 110, 210];
    const line = layer.encoding.line ?? [126, 156, 204, 255];
    return {
      id: layer.id,
      kind: 'geojson',
      url: layer.source.url,
      fill: withOpacity(fill, layer.opacity),
      line,
      lineWidthMinPixels: layer.encoding.lineWidthMinPixels,
    };
  }

  // Other source/type kinds (geo-query points, heatmaps, …) arrive in Step 4.
  return null;
}

/**
 * Build the ordered globe layer list from Scene State: a fixed ocean sphere base
 * (basemap, not a data layer) followed by the visible data layers.
 */
export function sceneToGlobeLayers(scene: SceneState): GlobeLayerSpec[] {
  const base: GlobeLayerSpec = { id: 'ocean', kind: 'sphere', color: [15, 28, 54] };
  const data = scene.layers.map(layerToSpec).filter((s): s is GlobeLayerSpec => s !== null);
  return [base, ...data];
}
