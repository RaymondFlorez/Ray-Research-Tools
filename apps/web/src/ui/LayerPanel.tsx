import type { Layer, PatchOp } from '@geoglobe/scene-schema';
import { useSceneStore } from '../store/sceneStore';
import { useLayerStatusStore } from '../store/layerStatusStore';
import type { LoadStatus } from '../data/useResolvedData';
import { Legend } from './Legend';

const STATUS_HINT: Record<LoadStatus, string> = {
  loading: 'Loading data from the Data Service…',
  ready: '',
  empty: 'The query returned no features for this view.',
  error: 'Data Service unreachable — start apps/api to load this layer.',
};

/**
 * Layer Control panel. Lists the Scene State layers and edits them exclusively by
 * emitting validated JSON Patches to the store — never by mutating layer objects
 * directly. This is the same mutation channel the LLM agent will use (Step 7), so the
 * UI and the agent stay perfectly interchangeable.
 */
export function LayerPanel() {
  const layers = useSceneStore((s) => s.scene.layers);
  const applyPatch = useSceneStore((s) => s.applyPatch);
  const status = useLayerStatusStore((s) => s.status);

  const patch = (ops: PatchOp[]) => {
    try {
      applyPatch(ops);
    } catch (err) {
      // A rejected patch (schema violation) is a bug in the panel, not user error.
      console.error('Rejected layer patch', err);
    }
  };

  const setVisible = (i: number, visible: boolean) =>
    patch([{ op: 'replace', path: `/layers/${i}/visible`, value: visible }]);

  const setOpacity = (i: number, opacity: number) =>
    patch([{ op: 'replace', path: `/layers/${i}/opacity`, value: opacity }]);

  const setPopFilter = (i: number, min: number) =>
    patch([{ op: 'replace', path: `/layers/${i}/encoding/filterRange`, value: [min, 40_000_000] }]);

  // Reorder by removing the layer and re-inserting it one slot up/down (two atomic ops).
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    const layer = layers[i];
    patch([
      { op: 'remove', path: `/layers/${i}` },
      { op: 'add', path: `/layers/${j}`, value: layer },
    ]);
  };

  return (
    <section className="panel">
      <h2>Layers</h2>
      <ul className="layer-list">
        {layers.map((layer, i) => (
          <li key={layer.id} className="layer-row">
            <div className="layer-head">
              <label className="layer-name">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(e) => setVisible(i, e.target.checked)}
                />
                <span>{layer.id}</span>
              </label>
              {status[layer.id] && status[layer.id] !== 'ready' && (
                <span
                  className={`layer-status layer-status-${status[layer.id]}`}
                  title={STATUS_HINT[status[layer.id]]}
                  data-testid={`status-${layer.id}`}
                >
                  {status[layer.id]}
                </span>
              )}
              <span className="layer-type">{layer.type}</span>
              <div className="layer-move">
                <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  aria-label="Move down"
                  disabled={i === layers.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </div>
            </div>

            <Legend layer={layer} />

            <div className="layer-control">
              <span className="ctrl-label">opacity</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layer.opacity}
                onChange={(e) => setOpacity(i, Number(e.target.value))}
              />
            </div>

            {hasPopFilter(layer) && (
              <div className="layer-control">
                <span className="ctrl-label">min pop</span>
                <input
                  type="range"
                  min={0}
                  max={20_000_000}
                  step={500_000}
                  value={layer.encoding.filterRange?.[0] ?? 0}
                  onChange={(e) => setPopFilter(i, Number(e.target.value))}
                />
                <span className="ctrl-value">
                  {formatPop(layer.encoding.filterRange?.[0] ?? 0)}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function hasPopFilter(layer: Layer): boolean {
  return layer.encoding.filterField === 'pop';
}

function formatPop(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1000).toFixed(0)}k`;
}
