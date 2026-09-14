/**
 * Data classification (PRD 7.2).
 *
 * "Four classes: `public`, `licensed`, `positions`, `mnpi_risk`. The
 * `data-access` layer stamps every record."
 *
 * The classes are ordered by how much damage leaving the tenant does, and
 * almost every rule in this package is a comparison against that order rather
 * than a check for a specific class. That matters when a class is added: a
 * rule written as `=== 'positions' || === 'mnpi_risk'` silently lets a new,
 * more sensitive class through, and a rule written as `>= positions` does not.
 *
 * Combining classifications takes the maximum, always. A prompt assembled from
 * a public filing and one position line is position data; there is no
 * averaging and no majority.
 */

export type Classification = 'public' | 'licensed' | 'positions' | 'mnpi_risk';

export const CLASSIFICATIONS: readonly Classification[] = [
  'public',
  'licensed',
  'positions',
  'mnpi_risk',
];

const RANK: Record<Classification, number> = {
  public: 0,
  licensed: 1,
  positions: 2,
  mnpi_risk: 3,
};

export function rank(c: Classification): number {
  return RANK[c];
}

export function atLeast(c: Classification, floor: Classification): boolean {
  return RANK[c] >= RANK[floor];
}

/** The most sensitive class present. An empty set is `public`. */
export function combine(classes: readonly Classification[]): Classification {
  let worst: Classification = 'public';
  for (const c of classes) if (RANK[c] > RANK[worst]) worst = c;
  return worst;
}

/**
 * Anything at or above `positions` must stay inside the tenant boundary.
 *
 * Named rather than inlined because two independent controls check it — the
 * router before dispatch and the egress proxy at the wire — and the two must
 * not be able to drift apart on what the threshold is.
 */
export const TENANT_BOUND_FLOOR: Classification = 'positions';

export function mustStayInTenant(c: Classification): boolean {
  return atLeast(c, TENANT_BOUND_FLOOR);
}

/** A record as the data-access layer stamps it. */
export interface Stamped<T> {
  tenantId: string;
  classification: Classification;
  /** Vendor whose licence governs redistribution, for `licensed` records. */
  vendor?: string;
  value: T;
}

export function stamp<T>(
  tenantId: string,
  classification: Classification,
  value: T,
  vendor?: string,
): Stamped<T> {
  return { tenantId, classification, value, ...(vendor !== undefined ? { vendor } : {}) };
}
