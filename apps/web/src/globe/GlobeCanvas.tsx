import { useEffect, useMemo, useRef } from 'react';
import { useSceneStore } from '../store/sceneStore';
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
  const interacting = useRef(false);
  const resolvedData = useResolvedData(scene.layers);

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
      onPick={(pick) => select(pick && { layerId: pick.layerId, featureIds: [pick.featureId] })}
    />
  );
}
