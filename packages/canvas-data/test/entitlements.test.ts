import { describe, expect, it } from 'vitest';
import {
  checkEgress,
  checkEntitlement,
  classifyPayload,
  filterEntitled,
  guardEgress,
  scanForFingerprints,
  type ClassifiedRecord,
  type Entitlements,
  type Fingerprint,
} from '../src/entitlements.js';

const maya: Entitlements = {
  userId: 'maya',
  tenantId: 'alphalytica',
  vendors: new Set(['refinitiv', 'iceberg']),
  positions: true,
  mnpi: false,
};

const intern: Entitlements = {
  userId: 'intern',
  tenantId: 'alphalytica',
  vendors: new Set(['iceberg']),
  positions: false,
  mnpi: false,
};

const records: ClassifiedRecord[] = [
  { id: 'close', dataClass: 'public' },
  { id: 'estimates', dataClass: 'licensed', vendor: 'refinitiv' },
  { id: 'chain', dataClass: 'licensed', vendor: 'opra' },
  { id: 'book', dataClass: 'positions' },
  { id: 'draft-8k', dataClass: 'mnpi_risk' },
];

describe('entitlements', () => {
  it('lets public data through to anyone', () => {
    expect(checkEntitlement(records[0] as ClassifiedRecord, intern).allowed).toBe(true);
  });

  it('gates licensed data on the vendor licence', () => {
    expect(checkEntitlement(records[1] as ClassifiedRecord, maya).allowed).toBe(true);
    const denied = checkEntitlement(records[1] as ClassifiedRecord, intern);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('no_vendor_licence');
    // The node says why, rather than rendering an empty chart.
    expect(denied.message).toContain('refinitiv');
  });

  it('gates positions and MNPI separately', () => {
    expect(checkEntitlement(records[3] as ClassifiedRecord, maya).allowed).toBe(true);
    expect(checkEntitlement(records[3] as ClassifiedRecord, intern).allowed).toBe(false);
    // Position access does not imply MNPI clearance.
    expect(checkEntitlement(records[4] as ClassifiedRecord, maya).allowed).toBe(false);
    expect(checkEntitlement(records[4] as ClassifiedRecord, maya).reason).toBe('no_mnpi_clearance');
  });

  it('splits a set into what may be shown and what must be explained', () => {
    const result = filterEntitled(records, maya);
    expect(result.allowed.map((r) => r.id)).toEqual(['close', 'estimates', 'book']);
    expect(result.blocked.map((b) => b.record.id)).toEqual(['chain', 'draft-8k']);
    // Every denial carries a reason: a blank chart reads as "no data", and this
    // is "not your data".
    expect(result.blocked.every((b) => b.decision.message !== undefined)).toBe(true);
  });
});

describe('egress: control one, the router', () => {
  it('classifies a payload by its most restricted member', () => {
    expect(classifyPayload([])).toBe('public');
    expect(classifyPayload(records.slice(0, 2))).toBe('licensed');
    expect(classifyPayload(records)).toBe('mnpi_risk');
  });

  it('refuses to send positions or MNPI outside the tenant', () => {
    const positions = [records[3] as ClassifiedRecord];
    expect(checkEgress(positions, 'tenant').allowed).toBe(true);
    const external = checkEgress(positions, 'external');
    expect(external.allowed).toBe(false);
    expect(external.reason).toContain('positions');

    expect(checkEgress([records[4] as ClassifiedRecord], 'external').allowed).toBe(false);
  });

  it('lets public and licensed data reach a vendor API', () => {
    expect(checkEgress(records.slice(0, 3), 'external').allowed).toBe(true);
  });
});

describe('egress: control two, the proxy', () => {
  const fingerprints: Fingerprint[] = [
    { label: 'position:NVDA-jan-1400-calls', value: 'NVDA Jan 1400 C' },
    { label: 'account', value: 'ACCT-99812' },
  ];

  it('blocks on a fingerprint even when the payload claims to be public', () => {
    // An agent assembled a prompt containing a holding and labelled it public.
    // The router would let this through; the proxy does not.
    const payload = 'Summarise the risk on our NVDA Jan 1400 C position.';
    const mislabelled: ClassifiedRecord[] = [{ id: 'prompt', dataClass: 'public' }];

    expect(checkEgress(mislabelled, 'external').allowed).toBe(true);
    const result = guardEgress({
      records: mislabelled,
      payload,
      destination: 'external',
      fingerprints,
      actor: 'ai-router',
      now: 1,
    });
    expect(result.decision.allowed).toBe(true);
    expect(result.scan.clean).toBe(false);
    expect(result.audit.allowed).toBe(false);
    expect(result.audit.blockedBy).toBe('proxy');
    expect(result.audit.matchedFingerprints).toEqual(['position:NVDA-jan-1400-calls']);
  });

  it('sees through reformatting, so a holding cannot be slipped past', () => {
    for (const payload of [
      'nvda jan 1400 c',
      'N.V.D.A. Jan 1400 C',
      'NVDA  Jan   1400   C',
      'NVDA-Jan-1400-C',
      '"NVDA Jan 1400 C"',
    ]) {
      expect(scanForFingerprints(payload, fingerprints).clean, payload).toBe(false);
    }
  });

  it('passes a payload with nothing of ours in it', () => {
    const scan = scanForFingerprints('What did the CFO say about gross margin?', fingerprints);
    expect(scan.clean).toBe(true);
    expect(scan.matched).toEqual([]);
  });

  it('ignores fingerprints too short to mean anything', () => {
    // A two-character fingerprint matches nearly every payload and would block
    // every request; that is a broken control, not a strict one.
    const scan = scanForFingerprints('anything at all', [{ label: 'tiny', value: 'at' }]);
    expect(scan.clean).toBe(true);
  });

  it('never echoes the matched value into the audit record', () => {
    const result = guardEgress({
      records: [{ id: 'p', dataClass: 'public' }],
      payload: 'ACCT-99812 holds it',
      destination: 'external',
      fingerprints,
      actor: 'ai-router',
      now: 2,
    });
    // Labels, not values: the audit log must not become the leak.
    expect(result.audit.matchedFingerprints).toEqual(['account']);
    expect(JSON.stringify(result.audit)).not.toContain('99812');
  });
});

describe('the two controls are independent', () => {
  const fingerprints: Fingerprint[] = [{ label: 'book', value: 'NVDA Jan 1400 C' }];

  it('the router blocks correctly-labelled position data the proxy would miss', () => {
    // Nothing in the text matches a fingerprint, but the data is positions.
    const result = guardEgress({
      records: [{ id: 'book', dataClass: 'positions' }],
      payload: 'aggregate vega is -3,870',
      destination: 'external',
      fingerprints,
      actor: 'ai-router',
      now: 3,
    });
    expect(result.scan.clean).toBe(true);
    expect(result.audit.allowed).toBe(false);
    expect(result.audit.blockedBy).toBe('router');
  });

  it('neither control interferes with a legitimate call', () => {
    const result = guardEgress({
      records: [{ id: 'transcript', dataClass: 'public' }],
      payload: 'Compare MD&A tone to the prior year.',
      destination: 'external',
      fingerprints,
      actor: 'ai-router',
      now: 4,
    });
    expect(result.audit.allowed).toBe(true);
    expect(result.audit.blockedBy).toBeUndefined();
  });

  it('does not scan for a call that stays inside the tenant', () => {
    const result = guardEgress({
      records: [{ id: 'book', dataClass: 'positions' }],
      payload: 'NVDA Jan 1400 C',
      destination: 'tenant',
      fingerprints,
      actor: 'local-model',
      now: 5,
    });
    expect(result.audit.allowed).toBe(true);
  });
});
