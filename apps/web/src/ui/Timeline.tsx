import type { PatchOp } from '@geoglobe/scene-schema';
import { useSceneStore } from '../store/sceneStore';

// Bounds of the synthetic earthquakes dataset (2026-01-07 … 2026-07-07).
const START = Date.UTC(2026, 0, 7);
const END = Date.UTC(2026, 6, 7);
const DAY = 86_400_000;

/**
 * Timeline scrubber bound to `scene.time.current`. Moving it filters time-aware layers
 * (the earthquakes layer, via its `timeField`) to events at or before the cursor. Every
 * change is a JSON Patch, so the whole view stays serializable and replayable.
 */
export function Timeline() {
  const current = useSceneStore((s) => s.scene.time.current);
  const applyPatch = useSceneStore((s) => s.applyPatch);

  const patch = (op: PatchOp) => applyPatch([op]);
  const setCurrent = (ms: number) =>
    patch({ op: 'replace', path: '/time/current', value: new Date(ms).toISOString() });
  const clear = () => patch({ op: 'replace', path: '/time/current', value: null });

  const value = current ? new Date(current).getTime() : END;
  const label = current ? new Date(current).toISOString().slice(0, 10) : 'all time';

  return (
    <div className="timeline panel" data-testid="timeline">
      <span className="timeline-title">Time</span>
      <input
        type="range"
        min={START}
        max={END}
        step={DAY}
        value={value}
        onChange={(e) => setCurrent(Number(e.target.value))}
        data-testid="timeline-slider"
        aria-label="Time cursor"
      />
      <span className="timeline-label" data-testid="timeline-label">
        {label}
      </span>
      <button className="timeline-all" onClick={clear} data-testid="timeline-all">
        reset
      </button>
    </div>
  );
}
