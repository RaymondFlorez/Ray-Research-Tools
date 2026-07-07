import { SCENE_SCHEMA_VERSION } from '@geoglobe/scene-schema';
import { GlobeCanvas } from './globe';
import { LayerPanel } from './ui/LayerPanel';
import { Inspector } from './ui/Inspector';
import { Timeline } from './ui/Timeline';
import { ChatPanel } from './ui/ChatPanel';
import { useSceneStore } from './store/sceneStore';

// `?test=1` disables auto-rotation so E2E can click a stable feature.
const TEST_MODE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('test');

export function App() {
  const layerCount = useSceneStore((s) => s.scene.layers.length);

  return (
    <div className="app">
      <div className="globe">
        <GlobeCanvas autoRotate={!TEST_MODE} />
      </div>

      <header className="overlay">
        <h1>GeoGlobe</h1>
        <p>Drag to orbit · scroll to zoom · click a feature</p>
        <span className="meta">
          scene-schema v{SCENE_SCHEMA_VERSION} · {layerCount} data layer
          {layerCount === 1 ? '' : 's'}
        </span>
      </header>

      <aside className="sidebar">
        <LayerPanel />
        <Inspector />
      </aside>

      <aside className="sidebar-left">
        <ChatPanel />
      </aside>

      <footer className="dock">
        <Timeline />
      </footer>
    </div>
  );
}
