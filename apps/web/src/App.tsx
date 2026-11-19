import { Suspense, lazy, useEffect } from 'react';
import { SCENE_SCHEMA_VERSION, type PatchOp } from '@geoglobe/scene-schema';
import { LayerPanel } from './ui/LayerPanel';
import { Inspector } from './ui/Inspector';
import { Timeline } from './ui/Timeline';
import { ChatPanel } from './ui/ChatPanel';
import { CommandPalette } from './ui/CommandPalette';
import { useSceneStore } from './store/sceneStore';
import { useUiStore } from './store/uiStore';

// The globe (deck.gl + luma.gl) is the heaviest part of the app; load it lazily so the
// panels and chat render immediately while the GL chunks stream in.
const GlobeCanvas = lazy(() =>
  import('./globe/GlobeCanvas').then((m) => ({ default: m.GlobeCanvas })),
);

// `?test=1` disables auto-rotation so E2E can click a stable feature.
const TEST_MODE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('test');

export function App() {
  const layerCount = useSceneStore((s) => s.scene.layers.length);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  // In test mode, expose the store so E2E/verification can drive the scene directly
  // (e.g. apply the same patches the agent would emit) without a live backend.
  useEffect(() => {
    if (!TEST_MODE) return;
    (window as unknown as { __geoglobe?: unknown }).__geoglobe = {
      applyPatch: (ops: PatchOp[]) => useSceneStore.getState().applyPatch(ops),
    };
  }, []);

  return (
    <div className="app">
      <div className="globe">
        <Suspense fallback={<div className="globe-loading">Loading globe…</div>}>
          <GlobeCanvas autoRotate={!TEST_MODE} />
        </Suspense>
      </div>

      <header className="overlay">
        <h1>GeoGlobe</h1>
        <p>Drag to orbit · scroll to zoom · click a feature</p>
        <span className="meta">
          scene-schema v{SCENE_SCHEMA_VERSION} · {layerCount} data layer
          {layerCount === 1 ? '' : 's'}
        </span>
        <div className="overlay-actions">
          <button onClick={() => setPaletteOpen(true)} data-testid="open-palette">
            Commands <kbd>⌘K</kbd>
          </button>
          <button
            onClick={toggleTheme}
            data-testid="toggle-theme"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <LayerPanel />
        <Inspector />
      </aside>

      <aside className="sidebar-left">
        <ChatPanel />
      </aside>

      <CommandPalette />

      <footer className="dock">
        <Timeline />
      </footer>
    </div>
  );
}
