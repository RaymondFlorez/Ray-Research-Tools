/**
 * Data classification, entitlements and egress control (PRD 7.2).
 *
 * Four classes, and the two that matter are `positions` and `mnpi_risk`:
 * portfolio holdings and anything that might be non-public never leave the
 * tenant boundary, whatever an agent has been talked into asking for.
 *
 * The PRD is explicit that this is enforced twice, and why: "The AI router
 * refuses to dispatch `positions` or `mnpi_risk` content to any external
 * endpoint. Independently, an egress proxy in front of all outbound vendor
 * calls scans payloads for tenant position fingerprints and blocks on match.
 * Two independent controls, because the router runs code that agents can
 * influence and the proxy does not."
 *
 * Both controls live here as pure functions. The first trusts the
 * classification attached to the data; the second trusts nothing and looks at
 * the bytes. A prompt injection that defeats the first has to also defeat the
 * second, and the second has no model in it to persuade.
 */

/** PRD 7.2. Ordered least to most restricted. */
export type DataClass = 'public' | 'licensed' | 'positions' | 'mnpi_risk';

const RESTRICTION: Record<DataClass, number> = {
  public: 0,
  licensed: 1,
  positions: 2,
  mnpi_risk: 3,
};

/** Classes that may never reach an endpoint outside the tenant. */
export const TENANT_ONLY: ReadonlySet<DataClass> = new Set<DataClass>(['positions', 'mnpi_risk']);

export interface ClassifiedRecord {
  /** What the record is, for the error message the analyst sees. */
  id: string;
  dataClass: DataClass;
  /** Which vendor's licence covers it, when it is licensed. */
  vendor?: string;
  value?: unknown;
}

export interface Entitlements {
  userId: string;
  tenantId: string;
  /** Vendors this user is licensed for. */
  vendors: ReadonlySet<string>;
  /** True when the user may see the tenant's positions. */
  positions: boolean;
  /** True when the user is cleared for material non-public information. */
  mnpi: boolean;
}

export type DenialReason = 'no_vendor_licence' | 'no_positions_access' | 'no_mnpi_clearance';

export interface EntitlementDecision {
  allowed: boolean;
  reason?: DenialReason;
  /** What the node shows instead of a value. */
  message?: string;
}

/**
 * Whether one record may be shown to one user.
 *
 * A denial is never a silent empty value: the node renders an
 * entitlement-blocked state, because a blank chart reads as "no data" and this
 * is "not your data".
 */
export function checkEntitlement(
  record: ClassifiedRecord,
  entitlements: Entitlements,
): EntitlementDecision {
  switch (record.dataClass) {
    case 'public':
      return { allowed: true };

    case 'licensed': {
      if (record.vendor === undefined || entitlements.vendors.has(record.vendor)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'no_vendor_licence',
        message: `Requires a ${record.vendor} licence.`,
      };
    }

    case 'positions':
      return entitlements.positions
        ? { allowed: true }
        : { allowed: false, reason: 'no_positions_access', message: 'Requires position access.' };

    case 'mnpi_risk':
      return entitlements.mnpi
        ? { allowed: true }
        : { allowed: false, reason: 'no_mnpi_clearance', message: 'Requires MNPI clearance.' };
  }
}

export interface FilterResult<T extends ClassifiedRecord> {
  allowed: T[];
  blocked: Array<{ record: T; decision: EntitlementDecision }>;
}

export function filterEntitled<T extends ClassifiedRecord>(
  records: readonly T[],
  entitlements: Entitlements,
): FilterResult<T> {
  const allowed: T[] = [];
  const blocked: FilterResult<T>['blocked'] = [];
  for (const record of records) {
    const decision = checkEntitlement(record, entitlements);
    if (decision.allowed) allowed.push(record);
    else blocked.push({ record, decision });
  }
  return { allowed, blocked };
}

/** The most restricted class present. An empty payload is public. */
export function classifyPayload(records: readonly ClassifiedRecord[]): DataClass {
  let highest: DataClass = 'public';
  for (const record of records) {
    if (RESTRICTION[record.dataClass] > RESTRICTION[highest]) highest = record.dataClass;
  }
  return highest;
}

export type Destination = 'tenant' | 'external';

export interface EgressDecision {
  allowed: boolean;
  dataClass: DataClass;
  reason?: string;
}

/**
 * Control one: the router's own check, on the classification attached to the
 * data it is about to send.
 */
export function checkEgress(
  records: readonly ClassifiedRecord[],
  destination: Destination,
): EgressDecision {
  const dataClass = classifyPayload(records);
  if (destination === 'tenant') return { allowed: true, dataClass };
  if (TENANT_ONLY.has(dataClass)) {
    return {
      allowed: false,
      dataClass,
      reason: `${dataClass} data cannot leave the tenant boundary`,
    };
  }
  return { allowed: true, dataClass };
}

export interface Fingerprint {
  /** What it identifies, for the audit record. */
  label: string;
  /** The literal string that must not appear in an outbound payload. */
  value: string;
}

export interface ScanResult {
  clean: boolean;
  /** Which fingerprints matched. Values are never echoed into the log. */
  matched: string[];
}

/**
 * Control two: the proxy's check, on the actual bytes.
 *
 * This one does not look at any classification, because a payload assembled by
 * an agent can carry position data with the label stripped off. It looks for
 * the tenant's own position fingerprints, and blocks on a match regardless of
 * what the payload claims to be.
 *
 * Matching is done on a normalized copy — case folded, punctuation and
 * whitespace removed — so an agent cannot slip a holding past by reformatting
 * it. Fingerprints shorter than four characters are ignored: they match
 * everything and would block every request.
 */
export function scanForFingerprints(
  payload: string,
  fingerprints: readonly Fingerprint[],
): ScanResult {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[\s,._'"()\-]/g, '');

  const haystack = normalize(payload);
  const matched: string[] = [];

  for (const fingerprint of fingerprints) {
    const needle = normalize(fingerprint.value);
    if (needle.length < 4) continue;
    if (haystack.includes(needle)) matched.push(fingerprint.label);
  }

  return { clean: matched.length === 0, matched };
}

export interface EgressAudit {
  at: number;
  actor: string;
  destination: Destination;
  dataClass: DataClass;
  allowed: boolean;
  /** Which control refused, when one did. */
  blockedBy?: 'router' | 'proxy';
  matchedFingerprints?: string[];
}

/**
 * Both controls, in the order they run, with the audit record the PRD requires
 * for "every AI dispatch".
 */
export function guardEgress(input: {
  records: readonly ClassifiedRecord[];
  payload: string;
  destination: Destination;
  fingerprints: readonly Fingerprint[];
  actor: string;
  now?: number;
}): { decision: EgressDecision; scan: ScanResult; audit: EgressAudit } {
  const decision = checkEgress(input.records, input.destination);
  const scan =
    input.destination === 'external'
      ? scanForFingerprints(input.payload, input.fingerprints)
      : { clean: true, matched: [] };

  const allowed = decision.allowed && scan.clean;
  const audit: EgressAudit = {
    at: input.now ?? Date.now(),
    actor: input.actor,
    destination: input.destination,
    dataClass: decision.dataClass,
    allowed,
  };
  if (!decision.allowed) audit.blockedBy = 'router';
  else if (!scan.clean) {
    audit.blockedBy = 'proxy';
    audit.matchedFingerprints = scan.matched;
  }

  return { decision, scan, audit };
}
