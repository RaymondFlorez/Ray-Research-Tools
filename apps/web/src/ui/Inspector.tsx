import { useInspectorStore } from '../store/inspectorStore';
import { useSceneStore } from '../store/sceneStore';

/**
 * Inspector panel: shows the properties of the currently selected feature. Selection is
 * driven by clicks on the globe, which write `scene.selection` (ids) via a JSON Patch;
 * this panel reads the transient picked properties from the inspector store.
 */
export function Inspector() {
  const picked = useInspectorStore((s) => s.picked);
  const selection = useSceneStore((s) => s.scene.selection);

  if (!picked || !selection) return null;

  const entries = Object.entries(picked.properties)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 12);

  return (
    <section className="panel inspector" data-testid="inspector">
      <h2>Inspector</h2>
      <div className="inspector-head">
        <span className="inspector-layer">{picked.layerId}</span>
        <span className="inspector-id" data-testid="inspector-id">
          {picked.featureId}
        </span>
      </div>
      <dl className="inspector-props">
        {entries.map(([k, v]) => (
          <div key={k} className="inspector-prop">
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
