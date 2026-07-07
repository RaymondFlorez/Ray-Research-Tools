import { SCENE_SCHEMA_VERSION } from '@geoglobe/scene-schema';
import { GlobeCanvas } from './globe';
import { LayerPanel } from './ui/LayerPanel';
import { useSceneStore } from './store/sceneStore';

export function App() {
  const layerCount = useSceneStore((s) => s.scene.layers.length);

  return (
    <div className="app">
      <div className="globe">
        <GlobeCanvas />
      </div>

      <header className="overlay">
        <h1>GeoGlobe</h1>
        <p>Drag to orbit · scroll to zoom · hover a feature</p>
        <span className="meta">
          scene-schema v{SCENE_SCHEMA_VERSION} · {layerCount} data layer
          {layerCount === 1 ? '' : 's'}
        </span>
      </header>

      <aside className="sidebar">
        <LayerPanel />
      </aside>
    </div>
  );
}
