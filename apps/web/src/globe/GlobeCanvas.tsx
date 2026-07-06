import { useEffect, useRef, useState } from 'react';
import { DeckGlobeRenderer } from './DeckGlobeRenderer';
import type { GlobeLayerSpec, GlobeRenderer, GlobeViewState } from './types';

const INITIAL_VIEW_STATE: GlobeViewState = { longitude: 0, latitude: 20, zoom: 0.9 };

// Step 2 MVP layers: a solid "ocean" sphere plus the static world-country polygons.
// Step 3 will move this list into the Scene State store and drive it from there.
const MVP_LAYERS: GlobeLayerSpec[] = [
  { id: 'ocean', kind: 'sphere', color: [15, 28, 54] },
  {
    id: 'countries',
    kind: 'geojson',
    url: `${import.meta.env.BASE_URL}data/countries.geojson`,
    fill: [58, 78, 110, 210],
    line: [126, 156, 204, 255],
    lineWidthMinPixels: 0.5,
  },
];

const AUTO_ROTATE_DEG_PER_SEC = 6;

export interface GlobeCanvasProps {
  /** Swap the rendering engine by passing a different renderer (default: deck.gl). */
  Renderer?: GlobeRenderer;
  /** Slowly spin the globe until the user interacts. Default true. */
  autoRotate?: boolean;
}

export function GlobeCanvas({ Renderer = DeckGlobeRenderer, autoRotate = true }: GlobeCanvasProps) {
  const [viewState, setViewState] = useState<GlobeViewState>(INITIAL_VIEW_STATE);
  const interacting = useRef(false);

  useEffect(() => {
    if (!autoRotate) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!interacting.current) {
        setViewState((v) => ({
          ...v,
          longitude:
            ((((v.longitude + dt * AUTO_ROTATE_DEG_PER_SEC + 180) % 360) + 360) % 360) - 180,
        }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate]);

  return (
    <Renderer
      viewState={viewState}
      onViewStateChange={setViewState}
      onInteractionChange={(active) => {
        interacting.current = active;
      }}
      layers={MVP_LAYERS}
    />
  );
}
