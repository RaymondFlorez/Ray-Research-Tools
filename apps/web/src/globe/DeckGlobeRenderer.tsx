import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { GlobeLayerSpec, GlobeRendererProps } from './types';

// A single polygon spanning the whole sphere; on a GlobeView this tessellates into
// the curved "ocean" surface behind the landmasses (the canonical deck.gl globe base).
const WHOLE_GLOBE: [number, number][] = [
  [-180, 90],
  [0, 90],
  [180, 90],
  [180, -90],
  [0, -90],
  [-180, -90],
];

function toDeckLayer(spec: GlobeLayerSpec): Layer {
  switch (spec.kind) {
    case 'sphere':
      return new SolidPolygonLayer({
        id: spec.id,
        data: [WHOLE_GLOBE],
        getPolygon: (d) => d as [number, number][],
        stroked: false,
        filled: true,
        getFillColor: [...spec.color, 255],
      });
    case 'geojson':
      return new GeoJsonLayer({
        id: spec.id,
        data: spec.url,
        stroked: true,
        filled: true,
        getFillColor: spec.fill,
        getLineColor: spec.line,
        lineWidthMinPixels: spec.lineWidthMinPixels ?? 0.5,
        pickable: true,
      });
    default: {
      // Exhaustiveness guard: adding a new GlobeLayerSpec kind forces handling here.
      const _never: never = spec;
      return _never;
    }
  }
}

/**
 * deck.gl implementation of the `GlobeRenderer` contract. Renders a true 3-D sphere
 * via deck.gl's GlobeView with orbit/zoom controls, no map token required.
 */
export function DeckGlobeRenderer({
  viewState,
  onViewStateChange,
  onInteractionChange,
  layers,
  controller = true,
}: GlobeRendererProps) {
  const view = useMemo(() => new GlobeView({ id: 'globe', resolution: 4 }), []);
  const deckLayers = useMemo(() => layers.map(toDeckLayer), [layers]);

  return (
    <DeckGL
      views={view}
      viewState={viewState}
      controller={controller}
      layers={deckLayers}
      getTooltip={({ object }: PickingInfo) =>
        object?.properties?.NAME ? { text: String(object.properties.NAME) } : null
      }
      onViewStateChange={(params: { viewState: Record<string, unknown> }) => {
        const vs = params.viewState;
        onViewStateChange?.({
          longitude: Number(vs.longitude),
          latitude: Number(vs.latitude),
          zoom: Number(vs.zoom),
          pitch: vs.pitch != null ? Number(vs.pitch) : undefined,
          bearing: vs.bearing != null ? Number(vs.bearing) : undefined,
        });
      }}
      onInteractionStateChange={(state: {
        isDragging?: boolean;
        isPanning?: boolean;
        isRotating?: boolean;
        isZooming?: boolean;
        inTransition?: boolean;
      }) => {
        const active = Boolean(
          state.isDragging ||
          state.isPanning ||
          state.isRotating ||
          state.isZooming ||
          state.inTransition,
        );
        onInteractionChange?.(active);
      }}
    />
  );
}
