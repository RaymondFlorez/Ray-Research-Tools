import { SCENE_SCHEMA_VERSION } from '@geoglobe/scene-schema';
import { GlobeCanvas } from './globe';

export function App() {
  return (
    <div className="app">
      <div className="globe">
        <GlobeCanvas />
      </div>
      <header className="overlay">
        <h1>GeoGlobe</h1>
        <p>Drag to orbit · scroll to zoom · hover a country</p>
        <span className="meta">scene-schema v{SCENE_SCHEMA_VERSION}</span>
      </header>
    </div>
  );
}
