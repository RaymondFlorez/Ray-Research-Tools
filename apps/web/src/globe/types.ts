import type { ComponentType } from 'react';

/**
 * Engine-agnostic globe abstraction.
 *
 * The rest of the app talks to the globe exclusively through these types, so the
 * rendering engine (deck.gl today; Cesium or three.js later) can be swapped by
 * providing a different component that satisfies `GlobeRenderer` — no caller changes.
 * See ARCHITECTURE.md §3.1.
 */

/** Camera state, engine-independent. Mirrors the `viewport` in the Scene State (§5). */
export interface GlobeViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/**
 * Declarative, engine-independent layer descriptors. A renderer translates each spec
 * into its own native layer. Step 4 replaces this narrow set with the full
 * `@geoglobe/layer-adapters` model; for the MVP we only need a base sphere + GeoJSON.
 */
export type GlobeLayerSpec =
  | { id: string; kind: 'sphere'; color: RGB }
  | {
      id: string;
      kind: 'geojson';
      /** URL to a static GeoJSON FeatureCollection. */
      url: string;
      fill: RGBA;
      line: RGBA;
      lineWidthMinPixels?: number;
    };

export interface GlobeRendererProps {
  viewState: GlobeViewState;
  onViewStateChange?: (viewState: GlobeViewState) => void;
  /** Fired as the user starts/stops interacting (drag, zoom, inertia). */
  onInteractionChange?: (active: boolean) => void;
  layers: GlobeLayerSpec[];
  /** Enable orbit/zoom controls. Default true. */
  controller?: boolean;
}

/**
 * A globe renderer is any React component honoring the props contract above.
 * `apps/web` depends on this type, never on a concrete engine.
 */
export type GlobeRenderer = ComponentType<GlobeRendererProps>;
