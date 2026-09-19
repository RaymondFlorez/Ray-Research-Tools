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
      // A licensed record with no vendor recorded is a denial, not a pass. The
      // first version read `record.vendor === undefined || vendors.has(...)`
      // and allowed it, on the reasoning that there was no licence to check —
      // but `licensed` is the stamp that says redistribution is governed by
      // someone's terms, and a missing vendor means we do not know whose. The
      // check that cannot be performed is the one that must not be assumed
      // passed: dropping the vendor field became a way to read every licensed
      // record in the tenant.
      if (record.vendor === undefined) {
        return {
          allowed: false,
          reason: 'no_vendor_licence',
          message: 'Licensed data with no vendor recorded; no licence covers it.',
        };
      }
      if (entitlements.vendors.has(record.vendor)) {
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
 * How far apart two parts of a fingerprint may sit and still count as one.
 *
 * Measured in normalized characters — letters and digits, everything else
 * already removed — between the end of one part and the start of the next.
 * `{"symbol":"NVDA","qty":12450}` normalizes to `symbolnvdaqty12450`, putting
 * three characters between the ticker and the quantity; a nested envelope puts
 * twenty or so. Forty-eight covers the serializations anyone actually emits
 * without loosening the match to "somewhere in the document", which is the
 * point at which a long filing matches something by chance.
 */
export const FINGERPRINT_GAP = 48;

/**
 * Control two: the proxy's check, on the actual bytes.
 *
 * This one does not look at any classification, because a payload assembled by
 * an agent can carry position data with the label stripped off. It looks for
 * the tenant's own position fingerprints, and blocks on a match regardless of
 * what the payload claims to be.
 *
 * Matching happens in two stages, and both exist because a literal substring
 * search over the raw payload catches only the one formatting the fingerprint
 * happened to be written in.
 *
 * **Normalization** keeps letters and digits and drops everything else. The
 * first version stripped a *list* of punctuation — whitespace, comma, period,
 * underscore, quote, parens, hyphen — and the list was the bug: it omitted
 * every separator a serializer actually emits, so a markdown row
 * `| NVDA | 12,450 |` and a colon-separated `NVDA: 12,450` both walked past. An
 * allowlist of kept characters cannot have that hole; a denylist of stripped
 * ones always can.
 *
 * **Segmentation and windowing** handle what normalization alone cannot.
 * Stripping punctuation does not help against text that is not punctuation:
 * `{"symbol":"NVDA","qty":12450}` normalizes to `symbolnvdaqty12450`, which
 * does not contain `nvda12450` because the key name sits between them, and
 * `<td>NVDA</td><td>12450</td>` fails the same way on the tag names. So the
 * fingerprint is cut into its letter-runs and digit-runs and each is located
 * independently; a match requires all of them inside one window of
 * `FINGERPRINT_GAP` characters per join. The cut is made on the *normalized*
 * form, so the fingerprint and the payload are segmented by the same rule and
 * a dotted `N.V.D.A.` is still one segment.
 *
 * What this still does not catch: an encoded payload. A scanner that sees
 * base64 sees nothing, and no amount of normalization changes that — it is the
 * blind spot the classification stamp in `checkEgress` covers, which is why
 * both controls run and neither is allowed to read the other's inputs.
 *
 * Fingerprints shorter than four characters after normalization are ignored:
 * they match everything and would block every request.
 */
export function scanForFingerprints(
  payload: string,
  fingerprints: readonly Fingerprint[],
): ScanResult {
  const haystack = normalizeForScan(payload);
  const matched: string[] = [];

  for (const fingerprint of fingerprints) {
    const needle = normalizeForScan(fingerprint.value);
    if (needle.length < 4) continue;
    if (containsSegments(haystack, segment(needle))) matched.push(fingerprint.label);
  }

  return { clean: matched.length === 0, matched };
}

/** Letters and digits, lowercased. An allowlist, deliberately. */
function normalizeForScan(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A normalized string cut into its letter-runs and digit-runs. */
function segment(normalized: string): string[] {
  return normalized.match(/[a-z]+|[0-9]+/g) ?? [];
}

/**
 * Whether every segment occurs in the haystack inside one bounded window.
 *
 * Order is not required: a serializer that writes the quantity before the
 * symbol states the holding just as plainly as one that does not. The window is
 * the smallest span covering one occurrence of each segment, found by sweeping
 * the merged occurrence list — the standard minimum-covering-window sweep, kept
 * here rather than approximated because a greedy first-occurrence match reports
 * a span far wider than the real one and would miss matches it should make.
 */
function containsSegments(haystack: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;

  const budget =
    segments.reduce((sum, seg) => sum + seg.length, 0) + FINGERPRINT_GAP * (segments.length - 1);

  // (position, which segment) for every occurrence of every segment.
  const hits: Array<{ at: number; seg: number }> = [];
  for (const [index, seg] of segments.entries()) {
    let from = haystack.indexOf(seg);
    if (from === -1) return false;
    while (from !== -1) {
      hits.push({ at: from, seg: index });
      from = haystack.indexOf(seg, from + 1);
    }
  }
  hits.sort((a, b) => a.at - b.at);

  const counts = new Array<number>(segments.length).fill(0);
  let covered = 0;
  let lo = 0;
  for (let hi = 0; hi < hits.length; hi += 1) {
    const entering = hits[hi];
    if (entering === undefined) continue;
    if ((counts[entering.seg] ?? 0) === 0) covered += 1;
    counts[entering.seg] = (counts[entering.seg] ?? 0) + 1;

    while (covered === segments.length) {
      const leaving = hits[lo];
      if (leaving === undefined) break;
      const span = entering.at + (segments[entering.seg]?.length ?? 0) - leaving.at;
      if (span <= budget) return true;
      counts[leaving.seg] = (counts[leaving.seg] ?? 0) - 1;
      if ((counts[leaving.seg] ?? 0) === 0) covered -= 1;
      lo += 1;
    }
  }
  return false;
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
