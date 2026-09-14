/**
 * Tenant isolation (PRD 7.2).
 *
 * "Every canvas, node, and artifact carries a tenant ID enforced at the query
 * layer via row-level security in Postgres and mandatory tenant predicates in
 * ClickHouse. Vector indexes are per-tenant collections, not a shared index
 * with a filter, because a filter bug in a shared index is a cross-tenant data
 * leak."
 *
 * That last sentence is the design, and it generalizes past vector indexes:
 * **a filter is something you can forget to apply, and a separate collection
 * is not.** So the two mechanisms here are different in kind, not just in
 * placement.
 *
 * `TenantQuery` is the filter-shaped one, for stores that genuinely are shared
 * (a relational table with row-level security). It is built so that forgetting
 * the predicate is impossible rather than merely discouraged: there is no way
 * to construct a query without a tenant, and a query whose predicate list
 * lacks a tenant term is rejected before it reaches the store.
 *
 * `TenantScoped` is the partition-shaped one, for everything that can be
 * partitioned. Collections are keyed by tenant and a handle to one tenant's
 * collection has no reachable path to another's.
 */

export class CrossTenantAccess extends Error {
  constructor(
    readonly actorTenant: string,
    readonly resourceTenant: string,
    readonly resource: string,
  ) {
    super(`tenant ${actorTenant} may not reach ${resource}, which belongs to ${resourceTenant}`);
    this.name = 'CrossTenantAccess';
  }
}

export class MissingTenantPredicate extends Error {
  constructor(readonly table: string) {
    super(`query against ${table} carries no tenant predicate`);
    this.name = 'MissingTenantPredicate';
  }
}

export interface TenantOwned {
  tenantId: string;
}

/**
 * A query that cannot be built without a tenant.
 *
 * The predicate is not a field the caller fills in; it is the constructor
 * argument, and `where()` can only add to it. This is the difference between
 * "we always pass the tenant" and "the type has no inhabitant without one".
 */
export class TenantQuery<T extends TenantOwned> {
  private readonly predicates: Array<(row: T) => boolean> = [];

  constructor(
    readonly table: string,
    readonly tenantId: string,
  ) {
    if (tenantId.trim() === '') throw new MissingTenantPredicate(table);
  }

  where(predicate: (row: T) => boolean): this {
    this.predicates.push(predicate);
    return this;
  }

  /**
   * Run against a row set.
   *
   * The tenant predicate is applied first and separately from the caller's
   * predicates, so a caller predicate that throws, short-circuits or is
   * written to return true cannot widen the result past the tenant.
   */
  run(rows: Iterable<T>): T[] {
    const out: T[] = [];
    for (const row of rows) {
      if (row.tenantId !== this.tenantId) continue;
      if (this.predicates.every((p) => p(row))) out.push(row);
    }
    return out;
  }
}

/**
 * Per-tenant collections.
 *
 * `collection(tenantId)` hands back a store that holds only that tenant's
 * records and has no reference to the map that holds the others. A caller
 * with a handle cannot widen it, because there is nothing wider to reach.
 */
export class TenantScoped<T> {
  private readonly collections = new Map<string, Map<string, T>>();

  collection(tenantId: string): Collection<T> {
    if (tenantId.trim() === '') throw new MissingTenantPredicate('collection');
    let store = this.collections.get(tenantId);
    if (!store) {
      store = new Map<string, T>();
      this.collections.set(tenantId, store);
    }
    return new Collection(tenantId, store);
  }

  /** How many tenants have a collection. For tests and for capacity, not for reads. */
  tenantCount(): number {
    return this.collections.size;
  }
}

export class Collection<T> {
  constructor(
    readonly tenantId: string,
    private readonly store: Map<string, T>,
  ) {}

  put(id: string, value: T): void {
    this.store.set(id, value);
  }

  get(id: string): T | undefined {
    return this.store.get(id);
  }

  ids(): string[] {
    return [...this.store.keys()];
  }

  all(): T[] {
    return [...this.store.values()];
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * The check for objects that carry a tenant and travel — a canvas handed to a
 * renderer, an artifact handed to an exporter.
 *
 * Throws rather than returning false. A cross-tenant read is not a condition
 * the caller gets to decide how to handle: every call site that could
 * reasonably continue would be continuing with somebody else's data in hand.
 */
export function assertSameTenant(actorTenant: string, resource: TenantOwned & { id?: string }): void {
  if (resource.tenantId !== actorTenant) {
    throw new CrossTenantAccess(actorTenant, resource.tenantId, resource.id ?? 'resource');
  }
}
