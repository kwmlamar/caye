/**
 * Reusable in-memory Supabase test double.
 *
 * Why this exists: a long tail of `lib/**\/*.test.ts` files hand-rolled their
 * own partial `createServiceClient()` fakes (a `from()` that only knew a
 * couple of tables, chain methods stubbed only as deep as that one test
 * happened to need). As production queries grew a filter deeper
 * (`.update().eq().in()`), added a new table, or started using `.upsert()`
 * or `.rpc()`, those ad hoc fakes silently fell behind and broke with
 * `TypeError: supabase.from(...).select is not a function` or similar.
 *
 * This module is the single place that surface should be maintained. It is
 * a real (if simplified) in-memory relational fake, in the spirit of
 * lib/goals/test-support/fake-goals-db.ts, generalized to any table instead
 * of one feature's schema:
 *
 *   - `seed(table, rows)` registers a table and its starting rows. A table
 *     that was never seeded is a bug in the test, not silently empty data —
 *     `from()` throws immediately naming the table.
 *   - `select().eq().neq().is().in().gt/gte/lt/lte().order().limit()` filter
 *     and order an in-memory copy; `.maybeSingle()` / `.single()` / `await`
 *     (the builder is thenable, matching supabase-js) resolve `{ data, error }`.
 *   - `insert()` / `upsert()` / `update()` / `delete()` mutate the table's row
 *     array in place, so a test can inspect `client.rows(table)` afterwards
 *     to assert exactly what was written — including defaults the fake never
 *     saw, since it only ever stores what production code actually sent.
 *   - `client.calls(table)` returns every chain-method invocation issued
 *     against that table, in order, as `[method, ...args]` tuples — for
 *     tests that want to assert *how* a query was built (e.g. that a
 *     workspace filter was applied) rather than only its result.
 *   - `.rpc(name, args)` is only usable after `client.onRpc(name, handler)`
 *     registers a handler; calling an unregistered rpc throws.
 *   - Any chain method this file does not implement (e.g. `.ilike()`,
 *     `.contains()`) throws a plain TypeError from the JS engine itself —
 *     there is no catch-all proxy that would swallow it into `undefined`.
 *
 * Not a general fake-postgres engine: there is no real SQL, no joins, no
 * column projection (a `.select('a, b, joined:other(c)')` still returns the
 * full seeded row — seed rows already shaped the way the query expects to
 * read them, the same convention the ad hoc fakes used).
 *
 * Usage:
 *
 *   const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
 *   vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))
 *
 *   const client = createFakeSupabaseClient()
 *   client.seed('caye_goals', [{ id: 'goal-1', workspace_id: 'workspace-a', ... }])
 *   mocks.createServiceClient.mockReturnValue(client)
 *
 *   // after execute():
 *   expect(client.calls('caye_goals')).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
 *   expect(client.rows('caye_goal_dependencies')).toContainEqual(expect.objectContaining({ ... }))
 */

export type FakeRow = Record<string, unknown>
export type FakeDbError = { message: string; code?: string }
export type FakeResult<T> = { data: T; error: FakeDbError | null }
export type FakeCall = [string, ...unknown[]]

type FilterFn = (row: FakeRow) => boolean

function isEqMatch(rowValue: unknown, filterValue: unknown): boolean {
  return rowValue === filterValue
}

function isNullAwareMatch(rowValue: unknown, filterValue: unknown): boolean {
  if (filterValue === null) return rowValue === null || rowValue === undefined
  return rowValue === filterValue
}

/** Orders numbers numerically and everything else (dates as ISO strings, text) lexicographically. */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

type TableState = {
  rows: FakeRow[]
  nextId: () => unknown
  uniqueKey: ((row: FakeRow) => string) | null
  calls: FakeCall[]
  /** When set, every read/write terminal against this table resolves to this error instead of touching rows. */
  error: FakeDbError | null
}

function defaultIdGenerator(table: string): () => string {
  let n = 0
  return () => `${table}-${++n}`
}

/** Shared filter/order/limit chain used by reads, updates, and deletes. */
abstract class FilterableQuery<Self> {
  protected filters: FilterFn[] = []

  constructor(protected readonly state: TableState) {}

  private record(call: FakeCall): void {
    this.state.calls.push(call)
  }

  eq(column: string, value: unknown): Self {
    this.record(['eq', column, value])
    this.filters.push((row) => isEqMatch(row[column], value))
    return this as unknown as Self
  }

  neq(column: string, value: unknown): Self {
    this.record(['neq', column, value])
    this.filters.push((row) => !isEqMatch(row[column], value))
    return this as unknown as Self
  }

  is(column: string, value: unknown): Self {
    this.record(['is', column, value])
    this.filters.push((row) => isNullAwareMatch(row[column], value))
    return this as unknown as Self
  }

  in(column: string, values: unknown[]): Self {
    this.record(['in', column, values])
    this.filters.push((row) => values.includes(row[column]))
    return this as unknown as Self
  }

  gt(column: string, value: unknown): Self {
    this.record(['gt', column, value])
    this.filters.push((row) => compareValues(row[column], value) > 0)
    return this as unknown as Self
  }

  gte(column: string, value: unknown): Self {
    this.record(['gte', column, value])
    this.filters.push((row) => compareValues(row[column], value) >= 0)
    return this as unknown as Self
  }

  lt(column: string, value: unknown): Self {
    this.record(['lt', column, value])
    this.filters.push((row) => compareValues(row[column], value) < 0)
    return this as unknown as Self
  }

  lte(column: string, value: unknown): Self {
    this.record(['lte', column, value])
    this.filters.push((row) => compareValues(row[column], value) <= 0)
    return this as unknown as Self
  }

  protected matched(): FakeRow[] {
    return this.state.rows.filter((row) => this.filters.every((f) => f(row)))
  }
}

class ReadQuery extends FilterableQuery<ReadQuery> implements PromiseLike<FakeResult<FakeRow[] | null>> {
  private orderCol: string | null = null
  private orderAsc = true
  private limitN: number | null = null

  select(columns?: string): this {
    this.state.calls.push(['select', columns])
    return this
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.state.calls.push(['order', column, opts])
    this.orderCol = column
    this.orderAsc = opts?.ascending ?? true
    return this
  }

  limit(n: number): this {
    this.state.calls.push(['limit', n])
    this.limitN = n
    return this
  }

  private resolve(): FakeRow[] {
    let result = this.matched()
    if (this.orderCol) {
      const col = this.orderCol
      const asc = this.orderAsc
      result = [...result].sort((a, b) => (asc ? compareValues(a[col], b[col]) : compareValues(b[col], a[col])))
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN)
    return result
  }

  async maybeSingle(): Promise<FakeResult<FakeRow | null>> {
    if (this.state.error) return { data: null, error: this.state.error }
    const rows = this.resolve()
    return { data: rows[0] ?? null, error: null }
  }

  async single(): Promise<FakeResult<FakeRow | null>> {
    if (this.state.error) return { data: null, error: this.state.error }
    const rows = this.resolve()
    if (rows.length !== 1) {
      return {
        data: null,
        error: {
          message: rows.length === 0 ? 'JSON object requested, no rows returned' : 'JSON object requested, multiple rows returned',
          code: 'PGRST116',
        },
      }
    }
    return { data: rows[0], error: null }
  }

  then<T1 = FakeResult<FakeRow[] | null>, T2 = never>(
    onFulfilled?: ((value: FakeResult<FakeRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const result: FakeResult<FakeRow[] | null> = this.state.error ? { data: null, error: this.state.error } : { data: this.resolve(), error: null }
    return Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class UpdateQuery extends FilterableQuery<UpdateQuery> implements PromiseLike<FakeResult<FakeRow[] | null>> {
  private applied = false
  private cached: FakeRow[] = []

  constructor(state: TableState, private readonly patch: FakeRow) {
    super(state)
    state.calls.push(['update', patch])
  }

  select(columns?: string): this {
    this.state.calls.push(['select', columns])
    return this
  }

  private apply(): FakeRow[] {
    if (this.applied) return this.cached
    this.applied = true
    this.cached = this.matched()
    for (const row of this.cached) Object.assign(row, this.patch)
    return this.cached
  }

  async single(): Promise<FakeResult<FakeRow | null>> {
    if (this.state.error) return { data: null, error: this.state.error }
    const rows = this.apply()
    if (rows.length !== 1) return { data: null, error: { message: 'no rows updated', code: 'PGRST116' } }
    return { data: rows[0], error: null }
  }

  async maybeSingle(): Promise<FakeResult<FakeRow | null>> {
    if (this.state.error) return { data: null, error: this.state.error }
    const rows = this.apply()
    return { data: rows[0] ?? null, error: null }
  }

  then<T1 = FakeResult<FakeRow[] | null>, T2 = never>(
    onFulfilled?: ((value: FakeResult<FakeRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const result: FakeResult<FakeRow[] | null> = this.state.error ? { data: null, error: this.state.error } : { data: this.apply(), error: null }
    return Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class DeleteQuery extends FilterableQuery<DeleteQuery> implements PromiseLike<FakeResult<FakeRow[] | null>> {
  private applied = false
  private cached: FakeRow[] = []

  constructor(state: TableState) {
    super(state)
    state.calls.push(['delete'])
  }

  private apply(): FakeRow[] {
    if (this.applied) return this.cached
    this.applied = true
    const removed = this.matched()
    const removedSet = new Set(removed)
    this.state.rows = this.state.rows.filter((row) => !removedSet.has(row))
    this.cached = removed
    return removed
  }

  then<T1 = FakeResult<FakeRow[] | null>, T2 = never>(
    onFulfilled?: ((value: FakeResult<FakeRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const result: FakeResult<FakeRow[] | null> = this.state.error ? { data: null, error: this.state.error } : { data: this.apply(), error: null }
    return Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class InsertQuery implements PromiseLike<FakeResult<FakeRow[] | null>> {
  private applied = false
  private inserted: FakeRow[] = []
  private conflictError: FakeDbError | null = null
  private readonly values: FakeRow[]

  constructor(private readonly state: TableState, values: FakeRow | FakeRow[]) {
    this.values = Array.isArray(values) ? values : [values]
    state.calls.push(['insert', values])
  }

  select(columns?: string): this {
    this.state.calls.push(['select', columns])
    return this
  }

  private apply(): void {
    if (this.applied) return
    this.applied = true
    if (this.state.error) {
      this.conflictError = this.state.error
      return
    }
    for (const value of this.values) {
      const row: FakeRow = { id: this.state.nextId(), ...value }
      if (this.state.uniqueKey) {
        const key = this.state.uniqueKey(row)
        if (this.state.rows.some((existing) => this.state.uniqueKey!(existing) === key)) {
          this.conflictError = { message: 'duplicate key value violates unique constraint', code: '23505' }
          return
        }
      }
      this.state.rows.push(row)
      this.inserted.push(row)
    }
  }

  async single(): Promise<FakeResult<FakeRow | null>> {
    this.apply()
    if (this.conflictError) return { data: null, error: this.conflictError }
    return { data: this.inserted[0] ?? null, error: null }
  }

  async maybeSingle(): Promise<FakeResult<FakeRow | null>> {
    return this.single()
  }

  then<T1 = FakeResult<FakeRow[] | null>, T2 = never>(
    onFulfilled?: ((value: FakeResult<FakeRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    this.apply()
    const result: FakeResult<FakeRow[] | null> = this.conflictError ? { data: null, error: this.conflictError } : { data: this.inserted, error: null }
    return Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class UpsertQuery implements PromiseLike<FakeResult<FakeRow[] | null>> {
  private applied = false
  private result: FakeRow[] = []
  private readonly values: FakeRow[]

  constructor(private readonly state: TableState, values: FakeRow | FakeRow[], private readonly onConflict?: string) {
    this.values = Array.isArray(values) ? values : [values]
    state.calls.push(['upsert', values, onConflict])
  }

  select(columns?: string): this {
    this.state.calls.push(['select', columns])
    return this
  }

  private matchKey(row: FakeRow): unknown {
    if (this.onConflict) return row[this.onConflict]
    if (this.state.uniqueKey) return this.state.uniqueKey(row)
    return row.id
  }

  private apply(): FakeRow[] {
    if (this.applied) return this.result
    this.applied = true
    for (const value of this.values) {
      const key = this.matchKey(value)
      const existing = key === undefined ? undefined : this.state.rows.find((row) => this.matchKey(row) === key)
      if (existing) {
        Object.assign(existing, value)
        this.result.push(existing)
      } else {
        const row: FakeRow = { id: this.state.nextId(), ...value }
        this.state.rows.push(row)
        this.result.push(row)
      }
    }
    return this.result
  }

  async single(): Promise<FakeResult<FakeRow | null>> {
    if (this.state.error) return { data: null, error: this.state.error }
    const rows = this.apply()
    return { data: rows[0] ?? null, error: null }
  }

  async maybeSingle(): Promise<FakeResult<FakeRow | null>> {
    return this.single()
  }

  then<T1 = FakeResult<FakeRow[] | null>, T2 = never>(
    onFulfilled?: ((value: FakeResult<FakeRow[] | null>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const result: FakeResult<FakeRow[] | null> = this.state.error ? { data: null, error: this.state.error } : { data: this.apply(), error: null }
    return Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class RpcQuery implements PromiseLike<FakeResult<unknown>> {
  constructor(private readonly resultPromise: Promise<FakeResult<unknown>>) {}

  then<T1 = FakeResult<unknown>, T2 = never>(
    onFulfilled?: ((value: FakeResult<unknown>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.resultPromise.then(onFulfilled ?? undefined, onRejected ?? undefined)
  }
}

class TableHandle {
  constructor(private readonly state: TableState) {}

  select(columns?: string): ReadQuery {
    return new ReadQuery(this.state).select(columns)
  }

  insert(values: FakeRow | FakeRow[]): InsertQuery {
    return new InsertQuery(this.state, values)
  }

  upsert(values: FakeRow | FakeRow[], opts?: { onConflict?: string }): UpsertQuery {
    return new UpsertQuery(this.state, values, opts?.onConflict)
  }

  update(patch: FakeRow): UpdateQuery {
    return new UpdateQuery(this.state, patch)
  }

  delete(): DeleteQuery {
    return new DeleteQuery(this.state)
  }
}

export type SeedOptions = {
  /** Generates the `id` for a newly inserted/upserted row that doesn't already carry one. */
  idGenerator?: () => unknown
  /** Mirrors a Postgres unique index: insert() fails with a 23505 error on a matching row. */
  uniqueKey?: (row: FakeRow) => string
  /**
   * Simulates an unavailable table: every read/write terminal against it
   * (select, insert, upsert, update, delete) resolves to `{ data: null,
   * error }` instead of touching rows — the same shape a real database
   * outage would surface, for exercising a capability's failure path.
   */
  error?: FakeDbError
}

export type RpcHandler = (args: Record<string, unknown>) => FakeResult<unknown> | Promise<FakeResult<unknown>>

/**
 * A test double for the object returned by `createServiceClient()` /
 * `createServerClient()`. See the module doc comment above for the full
 * usage story.
 */
export class FakeSupabaseClient {
  private tables = new Map<string, TableState>()
  private rpcHandlers = new Map<string, RpcHandler>()

  /** Registers a table and its starting rows. Call again to reseed (state, id generator, unique key, and error reset). */
  seed(table: string, rows: FakeRow[] = [], options: SeedOptions = {}): this {
    this.tables.set(table, {
      rows: rows.map((row) => ({ ...row })),
      nextId: options.idGenerator ?? defaultIdGenerator(table),
      uniqueKey: options.uniqueKey ?? null,
      calls: [],
      error: options.error ?? null,
    })
    return this
  }

  /** Current rows for a seeded table — reflects inserts/updates/deletes made during the test. */
  rows(table: string): FakeRow[] {
    return this.getState(table).rows
  }

  /** Every chain-method call issued against a seeded table, in order, as `[method, ...args]`. */
  calls(table: string): FakeCall[] {
    return this.getState(table).calls
  }

  /** Registers a handler for `.rpc(name, args)`. Calling an unregistered rpc throws. */
  onRpc(name: string, handler: RpcHandler): this {
    this.rpcHandlers.set(name, handler)
    return this
  }

  private getState(table: string): TableState {
    const state = this.tables.get(table)
    if (!state) {
      throw new Error(
        `FakeSupabaseClient: unknown table "${table}". Seed it first with client.seed("${table}", [...]) ` +
          'before the code under test can query it — an unseeded table is a bug in the test, not silently empty data.',
      )
    }
    return state
  }

  from(table: string): TableHandle {
    return new TableHandle(this.getState(table))
  }

  rpc(name: string, args: Record<string, unknown> = {}): RpcQuery {
    const handler = this.rpcHandlers.get(name)
    if (!handler) {
      throw new Error(`FakeSupabaseClient: unimplemented rpc "${name}". Register it first with client.onRpc("${name}", handler).`)
    }
    return new RpcQuery(Promise.resolve(handler(args)))
  }
}

export function createFakeSupabaseClient(): FakeSupabaseClient {
  return new FakeSupabaseClient()
}
