import { useEffect, useMemo, useRef } from 'react';
import type { Layer } from '@geoglobe/scene-schema';
import {
  coarseViewportBbox,
  decimatePoints,
  pointBudgetForZoom,
  type LngLat,
} from '@geoglobe/layer-adapters';
import { useSceneStore } from '../store/sceneStore';
import { useInspectorStore } from '../store/inspectorStore';
import { useLayerStatusStore } from '../store/layerStatusStore';
import { useResolvedData } from '../data/useResolvedData';
import { DeckGlobeRenderer } from './DeckGlobeRenderer';
import { viewportToViewState } from './sceneAdapter';
import type { GlobeRenderer } from './types';

const AUTO_ROTATE_DEG_PER_SEC = 6;

export interface GlobeCanvasProps {
  /** Swap the rendering engine by passing a different renderer (default: deck.gl). */
  Renderer?: GlobeRenderer;
  /** Slowly spin the globe until the user interacts. Default true. */
  autoRotate?: boolean;
}

/**
 * Renders the globe entirely FROM the Scene State store (the single source of truth).
 * Camera changes write back to the store via `setViewport`; layers, time, and selection
 * are read from the store. Feature clicks flow through the validated patch path.
 */
export function GlobeCanvas({ Renderer = DeckGlobeRenderer, autoRotate = true }: GlobeCanvasProps) {
  const scene = useSceneStore((s) => s.scene);
  const setViewport = useSceneStore((s) => s.setViewport);
  const select = useSceneStore((s) => s.select);
  const setPicked = useInspectorStore((s) => s.setPicked);
  const setStatus = useLayerStatusStore((s) => s.setStatus);
  const interacting = useRef(false);

  // Viewport culling (Step 11): a coarse, snapped bbox once zoomed in, null for the whole
  // globe. Memoized by its string form so the 60 fps camera updates don't create new
  // arrays (and refetches) unless the snapped box actually changes.
  const rawBbox = coarseViewportBbox(scene.viewport);
  const bboxKey = rawBbox ? rawBbox.join(',') : '';
  const bbox = useMemo(() => rawBbox, [bboxKey]); // keyed on the string form on purpose
  const { data, status } = useResolvedData(scene.layers, bbox);

  useEffect(() => setStatus(status), [status, setStatus]);

  // Level of detail: cap point counts per zoom band, keeping the most significant point
  // in each grid cell. Recomputed only when the data or the integer zoom band changes.
  const zoomBand = Math.floor(scene.viewport.zoom);
  const resolvedData = useMemo(
    () => decimateResolved(data, scene.layers, pointBudgetForZoom(zoomBand)),
    [data, scene.layers, zoomBand],
  );

  const viewState = useMemo(() => viewportToViewState(scene.viewport), [scene.viewport]);

  useEffect(() => {
    if (!autoRotate) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!interacting.current) {
        const vp = useSceneStore.getState().scene.viewport;
        const longitude =
          ((((vp.longitude + dt * AUTO_ROTATE_DEG_PER_SEC + 180) % 360) + 360) % 360) - 180;
        setViewport({ ...vp, longitude });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate, setViewport]);

  return (
    <Renderer
      viewState={viewState}
      layers={scene.layers}
      resolvedData={resolvedData}
      annotations={scene.annotations}
      time={scene.time}
      onViewStateChange={(vs) =>
        setViewport({
          longitude: vs.longitude,
          latitude: vs.latitude,
          zoom: vs.zoom,
          pitch: vs.pitch ?? 0,
          bearing: vs.bearing ?? 0,
        })
      }
      onInteractionChange={(active) => {
        interacting.current = active;
      }}
      onPick={(pick) => {
        select(pick && { layerId: pick.layerId, featureIds: [pick.featureId] });
        setPicked(pick);
      }}
    />
  );
}

function decimateResolved(
  data: Record<string, Record<string, unknown>[]>,
  layers: Layer[],
  budget: number,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [id, rows] of Object.entries(data)) {
    const layer = layers.find((l) => l.id === id);
    if (!layer || rows.length <= budget) {
      out[id] = rows;
      continue;
    }
    const [lngField, latField] = layer.encoding.position ?? ['lng', 'lat'];
    const radius = layer.encoding.radius;
    out[id] = decimatePoints(rows, budget, {
      getPosition: (d) => [Number(d[lngField]), Number(d[latField])] as LngLat,
      priorityField: typeof radius === 'string' ? radius : layer.encoding.color?.field,
    });
  }
  return out;
}
