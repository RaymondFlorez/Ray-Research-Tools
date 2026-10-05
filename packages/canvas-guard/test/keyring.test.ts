import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NoKeyForTenant, NotAKeyReference, VendorKeyring } from '../src/keyring.js';

function keyring() {
  const ring = new VendorKeyring();
  ring.register('acme', 'vendor-a', 'sm://tenants/acme/vendor-a');
  ring.register('acme', 'vendor-b', 'sm://tenants/acme/vendor-b');
  ring.register('globex', 'vendor-a', 'sm://tenants/globex/vendor-a');
  return ring;
}

describe('per-tenant vendor keys', () => {
  it("gives each tenant its own key for each vendor", () => {
    const ring = keyring();
    expect(ring.forTenant('acme').keyFor('vendor-a')).toBe('sm://tenants/acme/vendor-a');
    expect(ring.forTenant('globex').keyFor('vendor-a')).toBe('sm://tenants/globex/vendor-a');
  });

  it("refuses a vendor the tenant has no key for, rather than using anyone else's", () => {
    // globex has no vendor-b key. acme does, and the platform might; neither is used.
    expect(() => keyring().forTenant('globex').keyFor('vendor-b')).toThrow(NoKeyForTenant);
    expect(keyring().forTenant('globex').has('vendor-b')).toBe(false);
  });

  it('holds references, and refuses the key itself', () => {
    const ring = new VendorKeyring();
    expect(() => ring.register('acme', 'vendor-a', 'sk-live-3f9a8c7e2b1d')).toThrow(NotAKeyReference);
    expect(() => ring.register('acme', 'vendor-a', 'https://evil.example/key')).toThrow(NotAKeyReference);
  });

  it('prints nothing it holds', () => {
    expect(JSON.stringify({ keyring: keyring() })).not.toContain('sm://');
    // What console.log and a debugger's object view use.
    expect(inspect(keyring(), { depth: 10, showHidden: true })).not.toContain('sm://');
  });

  it("cannot be asked for another tenant's key through a tenant's handle", () => {
    const acme = keyring().forTenant('acme');
    // The handle has no lookup that takes a tenant; the only tenant it knows is its own.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(acme)).sort()).toEqual(['constructor', 'has', 'keyFor']);
    expect(acme.tenant).toBe('acme');
  });

  it('refuses a lookup with no tenant', () => {
    expect(() => keyring().forTenant(' ')).toThrow(/needs a tenant/);
  });
});
