import type { ComponentType } from 'react';
import type { Annotation, Layer as SceneLayer, TimeState } from '@geoglobe/scene-schema';

/**
 * Engine-agnostic globe abstraction.
 *
 * The app talks to the globe only through these types, so the rendering engine
 * (deck.gl today; Cesium or three.js later) can be swapped by providing a different
 * component that satisfies `GlobeRenderer`. Data layers are passed as canonical Scene
 * State `Layer[]`; each renderer translates them with its own adapter (deck.gl uses
 * `@geoglobe/layer-adapters`). See ARCHITECTURE.md §3.1.
 */

/** Camera state, engine-independent. Mirrors the `viewport` in the Scene State (§5). */
export interface GlobeViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export interface GlobeRendererProps {
  viewState: GlobeViewState;
  onViewStateChange?: (viewState: GlobeViewState) => void;
  /** Fired as the user starts/stops interacting (drag, zoom, inertia). */
  onInteractionChange?: (active: boolean) => void;
  /** Fired when a feature is clicked (or the empty globe, which clears selection). */
  onPick?: (pick: PickResult | null) => void;
  /** Canonical Scene State data layers to render. */
  layers: SceneLayer[];
  /** Data already fetched for geo-query layers (layerId → records). */
  resolvedData?: Record<string, unknown>;
  /** Pinned annotations (e.g. RAG results) to draw as labelled markers. */
  annotations?: Annotation[];
  /** Current time window, used by time-aware layers. */
  time?: TimeState;
  /** Enable orbit/zoom controls. Default true. */
  controller?: boolean;
}

/** A picked feature, normalized across engines. */
export interface PickResult {
  layerId: string;
  /** Stable feature id if resolvable, else the deck.gl object index as a string. */
  featureId: string;
  properties: Record<string, unknown>;
}

/**
 * A globe renderer is any React component honoring the props contract above.
 * `apps/web` depends on this type, never on a concrete engine.
 */
export type GlobeRenderer = ComponentType<GlobeRendererProps>;
