import { useEffect, useMemo, useRef } from 'react';
import { useSceneStore } from '../store/sceneStore';
import { DeckGlobeRenderer } from './DeckGlobeRenderer';
import { sceneToGlobeLayers, viewportToViewState } from './sceneAdapter';
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
 * Camera changes (drag/zoom/auto-rotate) write back to the store; layers are derived
 * from `scene.layers`. No rendering-only local state for what's on screen.
 */
export function GlobeCanvas({ Renderer = DeckGlobeRenderer, autoRotate = true }: GlobeCanvasProps) {
  const scene = useSceneStore((s) => s.scene);
  const setViewport = useSceneStore((s) => s.setViewport);
  const interacting = useRef(false);

  const viewState = useMemo(() => viewportToViewState(scene.viewport), [scene.viewport]);
  const layers = useMemo(() => sceneToGlobeLayers(scene), [scene]);

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
      layers={layers}
    />
  );
}
