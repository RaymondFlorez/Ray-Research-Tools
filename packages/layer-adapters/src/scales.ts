/** Pure color-scale helpers (no deck.gl / no DOM), so they're trivially unit-testable. */

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/** Sequential palettes as evenly-spaced control points, low → high. */
const PALETTES: Record<string, RGB[]> = {
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  plasma: [
    [13, 8, 135],
    [126, 3, 168],
    [204, 71, 120],
    [248, 149, 64],
    [240, 249, 33],
  ],
  magma: [
    [0, 0, 4],
    [81, 18, 124],
    [183, 55, 121],
    [252, 137, 97],
    [252, 253, 191],
  ],
  blues: [
    [247, 251, 255],
    [198, 219, 239],
    [107, 174, 214],
    [33, 113, 181],
    [8, 48, 107],
  ],
  warm: [
    [45, 0, 75],
    [150, 20, 90],
    [220, 80, 60],
    [250, 180, 50],
    [255, 255, 180],
  ],
};

export const SCALE_NAMES = Object.keys(PALETTES);

export function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function samplePalette(stops: RGB[], t: number): RGB {
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.floor(x);
  if (i >= stops.length - 1) return stops[stops.length - 1];
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(lerp(a[0], b[0], f)),
    Math.round(lerp(a[1], b[1], f)),
    Math.round(lerp(a[2], b[2], f)),
  ];
}

/** Get a `t ∈ [0,1] → RGB` ramp by name. Unknown names fall back to viridis. */
export function getColorScale(name: string): (t: number) => RGB {
  const stops = PALETTES[name] ?? PALETTES.viridis;
  return (t: number) => samplePalette(stops, t);
}

/** Normalize a value into [0,1] against a [min,max] domain. */
export function normalize(value: number, domain: [number, number]): number {
  const [lo, hi] = domain;
  if (hi === lo) return 0;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * Build a data-driven fill-color accessor: `datum → RGBA`, mapping `field` through a
 * named scale over `domain`. Alpha is fixed at 255 (layer opacity is applied separately).
 */
export function makeColorAccessor(
  field: string,
  scaleName: string,
  domain: [number, number],
): (datum: Record<string, unknown>) => RGBA {
  const scale = getColorScale(scaleName);
  return (datum) => {
    const raw = Number(datum[field]);
    const [r, g, b] = scale(normalize(raw, domain));
    return [r, g, b, 255];
  };
}
