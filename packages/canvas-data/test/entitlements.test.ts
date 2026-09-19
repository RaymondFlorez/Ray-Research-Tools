import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_GAP,
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

// ---------------------------------------------------------------------------
// Regressions from the security review.
// ---------------------------------------------------------------------------

describe('the fingerprint scanner survives reformatting', () => {
  // The scanner normalized by stripping a *list* of punctuation, and the list
  // omitted every separator a serializer actually emits. Each of these payloads
  // states a holding and each one walked straight through the control that
  // exists to survive a wrong classification stamp.
  const holding: Fingerprint[] = [{ label: 'nvda-position', value: 'NVDA 12,450' }];

  const reformatted = [
    'NVDA 12,450',
    '{"symbol":"NVDA","qty":12450}',
    '| NVDA | 12,450 |',
    'NVDA: 12,450 shares',
    'NVDA/12450',
    'NVDA\t12450',
    'symbol=NVDA;qty=12450',
    '<td>NVDA</td><td>12450</td>',
    '{"instrument":{"symbol":"NVDA"},"position":{"quantity":12450}}',
    'quantity 12450 of symbol NVDA',
    'N.V.D.A.  12_450',
  ];

  for (const payload of reformatted) {
    it(`matches ${JSON.stringify(payload)}`, () => {
      const scan = scanForFingerprints(payload, holding);
      expect(scan.clean).toBe(false);
      expect(scan.matched).toEqual(['nvda-position']);
    });
  }

  it('still does not match an unrelated payload', () => {
    expect(scanForFingerprints('AAPL closed up 1.2% on volume of 51m', holding).clean).toBe(true);
  });

  // The normalization is an allowlist of kept characters, so a separator nobody
  // thought of cannot open the hole again. This asserts the property rather
  // than the cases above, which is the part that does not rot.
  it('matches under an arbitrary separator', () => {
    for (const sep of ['~', '^', '§', '​', '\\', '::', ' ']) {
      expect(scanForFingerprints(`NVDA${sep}12450`, holding).clean).toBe(false);
    }
  });

  // The windowing is what closes the alphanumeric gaps, and it is the part that
  // could loosen the control into uselessness if the window were unbounded.
  // These pin the other side: the two halves of a fingerprint have to be near
  // each other, and neither half alone is a match.
  it('does not match the ticker alone', () => {
    expect(scanForFingerprints('NVDA rallied into the print', holding).clean).toBe(true);
  });

  it('does not match the quantity alone', () => {
    expect(scanForFingerprints('12,450 contracts traded on the tape', holding).clean).toBe(true);
  });

  it('does not match the two halves a page apart', () => {
    const apart = `NVDA${'x'.repeat(FINGERPRINT_GAP + 20)}12450`;
    expect(scanForFingerprints(apart, holding).clean).toBe(true);
  });

  it('matches right up to the gap and not past it', () => {
    const at = `NVDA${'x'.repeat(FINGERPRINT_GAP)}12450`;
    const past = `NVDA${'x'.repeat(FINGERPRINT_GAP + 1)}12450`;
    expect(scanForFingerprints(at, holding).clean).toBe(false);
    expect(scanForFingerprints(past, holding).clean).toBe(true);
  });

  it('does not match a filing that happens to contain both far apart', () => {
    const filing = [
      'Item 7A. Quantitative and Qualitative Disclosures About Market Risk.',
      'NVDA was among the largest contributors to sector performance in the period,',
      'as discussed at length in the preceding section and in our prior filings,',
      'and the registrant reported 12,450 full-time employees as of the record date.',
    ].join(' ');
    expect(scanForFingerprints(filing, holding).clean).toBe(true);
  });
});

describe('licensed data with no vendor', () => {
  const user: Entitlements = {
    userId: 'u1',
    tenantId: 'a',
    vendors: new Set(['vendor-x']),
    positions: false,
    mnpi: false,
  };

  // `licensed` means redistribution is governed by someone's terms. A missing
  // vendor means we do not know whose, which is a denial: the check that cannot
  // be performed must not be assumed passed. Dropping the field was otherwise a
  // way to read every licensed record in the tenant.
  it('is denied rather than allowed', () => {
    const record: ClassifiedRecord = { id: 'r1', dataClass: 'licensed' };
    const decision = checkEntitlement(record, user);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_vendor_licence');
    expect(decision.message).toMatch(/no vendor/i);
  });

  it('is denied even to a user licensed for every vendor there is', () => {
    const everything: Entitlements = { ...user, vendors: new Set(['vendor-x', 'vendor-y']) };
    expect(checkEntitlement({ id: 'r1', dataClass: 'licensed' }, everything).allowed).toBe(false);
  });

  it('does not take a licensed record with a vendor down with it', () => {
    expect(
      checkEntitlement({ id: 'r2', dataClass: 'licensed', vendor: 'vendor-x' }, user).allowed,
    ).toBe(true);
  });

  it('is filtered out in bulk', () => {
    const { allowed, blocked } = filterEntitled(
      [
        { id: 'a', dataClass: 'licensed', vendor: 'vendor-x' },
        { id: 'b', dataClass: 'licensed' },
        { id: 'c', dataClass: 'public' },
      ],
      user,
    );
    expect(allowed.map((r) => r.id)).toEqual(['a', 'c']);
    expect(blocked.map((b) => b.record.id)).toEqual(['b']);
  });
});
