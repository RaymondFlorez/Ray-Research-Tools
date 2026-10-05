/**
 * Per-tenant vendor keys (PRD 4.4).
 *
 * > Frontier closed models ... Vendor API, per-tenant key isolation.
 *
 * Each tenant's calls to a vendor go out under that tenant's own key, so a
 * vendor's logs, rate limits, retention settings and bill are per tenant and
 * one tenant's traffic is never attributable to another. Three rules, each one
 * a way the obvious implementation leaks.
 *
 * ## No platform key to fall back to
 *
 * The convenient keyring has a default: if the tenant has no key for this
 * vendor, use the platform's. That is precisely how a tenant's prompts end up
 * under an account whose retention and data-processing terms the tenant never
 * agreed to. A missing key is a refusal, and the decision is the tenant's.
 *
 * ## It holds references, not secrets
 *
 * Keys live in the secret manager; this holds the reference the dispatcher
 * resolves at the last moment. A heap dump, a log line or an error message
 * that captures the keyring captures identifiers, not credentials.
 *
 * ## There is no way to list another tenant's keys
 *
 * Lookup is by tenant and vendor, from a `TenantScoped` handle that carries the
 * tenant it was opened for. There is no method that returns the map, and no
 * lookup that takes a tenant as a free argument alongside a handle for
 * another — the same shape as `TenantQuery`.
 */

/** A pointer into the secret manager, e.g. `sm://tenants/acme/vendor-a`. */
export type KeyRef = string & { readonly __keyRef: unique symbol };

export class NoKeyForTenant extends Error {
  constructor(readonly tenant: string, readonly vendor: string) {
    super(
      `${tenant} has no ${vendor} key; the call is refused rather than sent under the platform's ` +
        "or another tenant's account",
    );
    this.name = 'NoKeyForTenant';
  }
}

export class NotAKeyReference extends Error {
  constructor() {
    super('the keyring holds secret-manager references, not keys: pass sm://… rather than the secret');
    this.name = 'NotAKeyReference';
  }
}

const REFERENCE = /^sm:\/\/[a-z0-9][a-z0-9/_.-]*$/i;

export class VendorKeyring {
  // A true private field: TypeScript's `private` is erased at runtime, and
  // `console.log` of the keyring would print every reference it holds.
  readonly #refs = new Map<string, Map<string, KeyRef>>();

  /**
   * Registers a tenant's key for a vendor, by reference.
   *
   * Anything that does not look like a reference is refused, because the
   * likeliest thing to be passed here by mistake is the key itself.
   */
  register(tenant: string, vendor: string, reference: string): void {
    if (!REFERENCE.test(reference)) throw new NotAKeyReference();
    let byVendor = this.#refs.get(tenant);
    if (!byVendor) {
      byVendor = new Map();
      this.#refs.set(tenant, byVendor);
    }
    byVendor.set(vendor, reference as KeyRef);
  }

  /** A handle that can only ever look up keys for one tenant. */
  forTenant(tenant: string): TenantKeys {
    if (tenant.trim() === '') throw new Error('a key lookup needs a tenant');
    return new TenantKeys(tenant, (vendor) => this.#refs.get(tenant)?.get(vendor));
  }

  /** Never print what the keyring holds. */
  toJSON(): string {
    return '[VendorKeyring]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[VendorKeyring]';
  }
}

export class TenantKeys {
  constructor(
    readonly tenant: string,
    private readonly lookup: (vendor: string) => KeyRef | undefined,
  ) {}

  /** This tenant's key reference for a vendor, or a refusal. Never a fallback. */
  keyFor(vendor: string): KeyRef {
    const ref = this.lookup(vendor);
    if (!ref) throw new NoKeyForTenant(this.tenant, vendor);
    return ref;
  }

  has(vendor: string): boolean {
    return this.lookup(vendor) !== undefined;
  }
}
