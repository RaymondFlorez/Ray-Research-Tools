import { SCENE_SCHEMA_VERSION } from '@geoglobe/scene-schema';

export function App() {
  return (
    <main className="app">
      <h1>GeoGlobe</h1>
      <p>
        3-D Earth globe with data layers and natural-language querying. The globe canvas lands in
        Step 2 of <code>docs/BUILD_PROMPTS.md</code>.
      </p>
      <p className="meta">scene-schema v{SCENE_SCHEMA_VERSION}</p>
    </main>
  );
}
