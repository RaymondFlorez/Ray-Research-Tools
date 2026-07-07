import type { Layer as DeckLayer } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, ColumnLayer, BitmapLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { MVTLayer, TileLayer } from '@deck.gl/geo-layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import type { Layer } from '@geoglobe/scene-schema';
import { buildLayerSpec, type BuildOptions, type DeckLayerSpec } from './spec';

/* eslint-disable @typescript-eslint/no-explicit-any -- deck.gl layer props are loosely typed here */

const CONSTRUCTORS = {
  GeoJsonLayer,
  ScatterplotLayer,
  ColumnLayer,
  HeatmapLayer,
  MVTLayer,
  TileLayer,
} as const;

/** Turn a pure `DeckLayerSpec` into a live deck.gl layer instance. */
export function specToDeckLayer(spec: DeckLayerSpec): DeckLayer {
  const props: Record<string, unknown> = { ...spec.props };

  // A filter spec (attribute/time) needs the DataFilterExtension wired in.
  if ('getFilterValue' in props) {
    props.extensions = [new DataFilterExtension({ filterSize: (props.filterSize as 1 | 2) ?? 1 })];
  }

  if (spec.raster) {
    return new TileLayer({
      ...props,
      renderSubLayers: (subProps: any) => {
        const { boundingBox } = subProps.tile;
        return new BitmapLayer(subProps, {
          data: undefined,
          image: subProps.data,
          bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
        });
      },
    });
  }

  const Ctor = CONSTRUCTORS[spec.type];
  return new Ctor(props as any);
}

/** Build live deck.gl layers directly from canonical Scene State layers. */
export function buildDeckLayers(layers: readonly Layer[], opts: BuildOptions = {}): DeckLayer[] {
  return layers.map((layer) => specToDeckLayer(buildLayerSpec(layer, opts)));
}
