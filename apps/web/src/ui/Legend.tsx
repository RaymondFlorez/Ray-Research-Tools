import type { Layer } from '@geoglobe/scene-schema';
import { getColorScale } from '@geoglobe/layer-adapters';

const STOPS = 6;

/**
 * Compact legend for a layer's color encoding: a gradient bar sampled from the same
 * color scale the renderer uses, labelled with the field and domain. Falls back to a
 * swatch for layers with a static fill.
 */
export function Legend({ layer }: { layer: Layer }) {
  const color = layer.encoding.color;
  if (color) {
    const scale = getColorScale(color.scale);
    const stops = Array.from({ length: STOPS }, (_, i) => {
      const [r, g, b] = scale(i / (STOPS - 1));
      return `rgb(${r}, ${g}, ${b}) ${(i / (STOPS - 1)) * 100}%`;
    });
    const [min, max] = color.domain ?? [0, 1];
    return (
      <div className="legend" data-testid={`legend-${layer.id}`}>
        <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${stops})` }} />
        <div className="legend-labels">
          <span>{formatValue(min)}</span>
          <span className="legend-field">{color.field}</span>
          <span>{formatValue(max)}</span>
        </div>
      </div>
    );
  }
  const fill = layer.encoding.fill;
  if (Array.isArray(fill)) {
    const [r, g, b, a = 255] = fill;
    return (
      <div className="legend legend-static" data-testid={`legend-${layer.id}`}>
        <span
          className="legend-swatch"
          style={{ background: `rgba(${r}, ${g}, ${b}, ${a / 255})` }}
        />
        <span className="legend-field">fill</span>
      </div>
    );
  }
  return null;
}

function formatValue(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
