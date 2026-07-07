/** Pure time-filter helpers used by time-aware layers (e.g. earthquakes in Step 5). */

export type TimeRange = [string, string] | null;

function ms(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Is a timestamp visible under the current time window?
 *  - explicit `range` → inside [start, end]
 *  - else `current`   → at or before the cursor (accumulating view)
 *  - else             → always visible
 * Rows with no/invalid timestamp are always visible (fail-open).
 */
export function withinTime(
  ts: string | number | null | undefined,
  range: TimeRange,
  current: string | null,
): boolean {
  const t = ms(ts);
  if (t == null) return true;

  if (range) {
    const a = ms(range[0]);
    const b = ms(range[1]);
    if (a != null && b != null) return t >= a && t <= b;
  }
  const c = ms(current);
  if (c != null) return t <= c;
  return true;
}

/** Filter an already-loaded array of records by a timestamp field. */
export function filterByTime<T extends Record<string, unknown>>(
  rows: readonly T[],
  timeField: string,
  range: TimeRange,
  current: string | null,
): T[] {
  return rows.filter((r) =>
    withinTime(r[timeField] as string | number | undefined, range, current),
  );
}
