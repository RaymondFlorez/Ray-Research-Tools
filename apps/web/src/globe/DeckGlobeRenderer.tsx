import { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView, type Layer, type PickingInfo } from '@deck.gl/core';
import { SolidPolygonLayer } from '@deck.gl/layers';
import { buildDeckLayers } from '@geoglobe/layer-adapters';
import type { GlobeRendererProps, PickResult } from './types';

// A single polygon spanning the whole sphere; on a GlobeView this tessellates into the
// curved "ocean" surface behind the data layers (the canonical deck.gl globe base).
const WHOLE_GLOBE: [number, number][] = [
  [-180, 90],
  [0, 90],
  [180, 90],
  [180, -90],
  [0, -90],
  [-180, -90],
];

const OCEAN_COLOR: [number, number, number, number] = [15, 28, 54, 255];

function tooltipText(object: Record<string, unknown> | null | undefined): string | null {
  if (!object) return null;
  // GeoJSON features carry a `properties` bag; flat records carry fields directly.
  const props = (object.properties as Record<string, unknown> | undefined) ?? object;
  const name = props.NAME ?? props.name;
  return name != null ? String(name) : null;
}

function toPick(info: PickingInfo): PickResult | null {
  if (!info.layer || info.object == null) return null;
  const object = info.object as Record<string, unknown>;
  const props = (object.properties as Record<string, unknown> | undefined) ?? object;
  const featureId =
    (props.id as string | undefined) ??
    (props.NAME as string | undefined) ??
    (props.name as string | undefined) ??
    String(info.index);
  return { layerId: info.layer.id, featureId, properties: props };
}

/**
 * deck.gl implementation of the `GlobeRenderer` contract: a true 3-D sphere via
 * GlobeView with an ocean base, plus data layers built from canonical Scene State by
 * `@geoglobe/layer-adapters`. No map token required.
 */
export function DeckGlobeRenderer({
  viewState,
  onViewStateChange,
  onInteractionChange,
  onPick,
  layers,
  resolvedData,
  time,
  controller = true,
}: GlobeRendererProps) {
  const view = useMemo(() => new GlobeView({ id: 'globe', resolution: 4 }), []);

  const ocean = useMemo(
    () =>
      new SolidPolygonLayer({
        id: 'ocean',
        data: [WHOLE_GLOBE],
        getPolygon: (d) => d as [number, number][],
        stroked: false,
        filled: true,
        getFillColor: OCEAN_COLOR,
      }),
    [],
  );

  const dataLayers = useMemo(
    () =>
      buildDeckLayers(layers, {
        currentTime: time?.current,
        timeRange: time?.range,
        resolvedData: resolvedData as Record<string, unknown> | undefined,
      }),
    [layers, time?.current, time?.range, resolvedData],
  );

  const allLayers: Layer[] = useMemo(() => [ocean, ...dataLayers], [ocean, dataLayers]);

  return (
    <DeckGL
      views={view}
      viewState={viewState}
      controller={controller}
      layers={allLayers}
      getTooltip={({ object }: PickingInfo) => {
        const text = tooltipText(object as Record<string, unknown> | null);
        return text ? { text } : null;
      }}
      onClick={(info: PickingInfo) => {
        if (!onPick) return;
        // A click on the ocean base (or empty space) clears the selection.
        onPick(info.layer && info.layer.id !== 'ocean' ? toPick(info) : null);
      }}
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
