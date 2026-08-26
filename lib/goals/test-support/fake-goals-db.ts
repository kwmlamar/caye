/**
 * Minimal in-memory fake of the Supabase query builder, scoped exactly to
 * the chains lib/goals/goals.ts actually issues against caye_goals /
 * caye_goal_dependencies / caye_goal_metrics. Not a general Supabase mock —
 * narrow on purpose, same spirit as the hand-rolled mocks elsewhere in this
 * repo (e.g. add-business-fact.test.ts) rather than a generic fake-postgres
 * engine. Used by lib/goals/goals.test.ts via
 * vi.mock('@/lib/supabase-server', ...).
 */

type Row = Record<string, unknown>

function matchesIs(rowValue: unknown, filterValue: unknown): boolean {
  if (filterValue === null) return rowValue === null || rowValue === undefined
  return rowValue === filterValue
}

class Builder {
  protected filters: Array<(row: Row) => boolean> = []
  protected orderCol: string | null = null
  protected orderAsc = true
  protected limitN: number | null = null

  constructor(protected rows: Row[]) {}

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val)
    return this
  }

  is(col: string, val: unknown): this {
    this.filters.push((row) => matchesIs(row[col], val))
    return this
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col
    this.orderAsc = opts?.ascending ?? true
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  protected resolveRows(): Row[] {
    let result = this.rows.filter((row) => this.filters.every((f) => f(row)))
    if (this.orderCol) {
      const col = this.orderCol
      result = [...result].sort((a, b) => {
        const av = a[col] as string | number
        const bv = b[col] as string | number
        if (av < bv) return this.orderAsc ? -1 : 1
        if (av > bv) return this.orderAsc ? 1 : -1
        return 0
      })
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN)
    return result
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.resolveRows()
    return { data: rows[0] ?? null, error: null }
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const rows = this.resolveRows()
    if (rows.length === 0) return { data: null, error: { message: 'not found' } }
    return { data: rows[0], error: null }
  }

  // Thenable: `await builder` without an explicit terminal call resolves
  // the array result, matching supabase-js's own PromiseLike builders.
  then<T1, T2>(
    onFulfilled?: (value: { data: Row[]; error: null }) => T1 | PromiseLike<T1>,
    onRejected?: (reason: unknown) => T2 | PromiseLike<T2>
  ): PromiseLike<T1 | T2> {
    return Promise.resolve({ data: this.resolveRows(), error: null }).then(onFulfilled, onRejected)
  }
}

class SelectBuilder extends Builder {}

class UpdateBuilder extends Builder {
  private applied = false
  constructor(rows: Row[], private patch: Row) {
    super(rows)
  }

  private apply(): Row[] {
    if (this.applied) return this.resolveRows()
    const matched = this.rows.filter((row) => this.filters.every((f) => f(row)))
    for (const row of matched) Object.assign(row, this.patch)
    this.applied = true
    return matched
  }

  select(_cols?: string): this {
    return this
  }

  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const matched = this.apply()
    if (matched.length === 0) return { data: null, error: { message: 'not found' } }
    return { data: matched[0], error: null }
  }

  then<T1, T2>(
    onFulfilled?: (value: { data: Row[]; error: null }) => T1 | PromiseLike<T1>,
    onRejected?: (reason: unknown) => T2 | PromiseLike<T2>
  ): PromiseLike<T1 | T2> {
    const matched = this.apply()
    return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected)
  }
}

class InsertBuilder {
  private resolved: { data: Row | null; error: { code: string; message: string } | null } | null = null
  constructor(private table: FakeTable, private row: Row) {}

  private doInsert() {
    if (!this.resolved) {
      const inserted = this.table.push(this.row)
      this.resolved = inserted
        ? { data: inserted, error: null }
        : { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
    }
    return this.resolved
  }

  select(_cols?: string): this {
    return this
  }

  async single(): Promise<{ data: Row | null; error: { code: string; message: string } | null }> {
    return this.doInsert()
  }

  then<T1, T2>(
    onFulfilled?: (value: { data: null; error: { code: string; message: string } | null }) => T1 | PromiseLike<T1>,
    onRejected?: (reason: unknown) => T2 | PromiseLike<T2>
  ): PromiseLike<T1 | T2> {
    const { error } = this.doInsert()
    return Promise.resolve({ data: null, error }).then(onFulfilled, onRejected)
  }
}

export class FakeTable {
  rows: Row[] = []
  private nextId = 1
  constructor(
    private idPrefix: string,
    private useNumericId = false,
    /** Mirrors a Postgres unique index — e.g. caye_goal_dependencies_unique
     *  on (goal_id, depends_on_goal_id). Returns null to opt out. */
    private uniqueKey: ((row: Row) => string) | null = null
  ) {}

  /** Returns null (instead of throwing) on a unique-constraint violation,
   *  matching how InsertBuilder distinguishes success from a 23505 error. */
  push(partial: Row): Row | null {
    const now = new Date().toISOString()
    const row: Row = {
      id: this.useNumericId ? this.nextId++ : `${this.idPrefix}-${this.nextId++}`,
      created_at: now,
      updated_at: now,
      superseded_at: null,
      superseded_by: null,
      ...partial,
    }
    if (this.uniqueKey) {
      const key = this.uniqueKey(row)
      if (this.rows.some((r) => this.uniqueKey!(r) === key)) return null
    }
    this.rows.push(row)
    return row
  }

  select(_cols?: string): SelectBuilder {
    return new SelectBuilder(this.rows)
  }

  insert(row: Row): InsertBuilder {
    return new InsertBuilder(this, row)
  }

  update(patch: Row): UpdateBuilder {
    return new UpdateBuilder(this.rows, patch)
  }
}

export function createFakeGoalsClient() {
  const goals = new FakeTable('goal')
  const dependencies = new FakeTable('dep', true, (row) => `${row.goal_id}::${row.depends_on_goal_id}`)
  const metrics = new FakeTable('metric', true)

  const tables: Record<string, FakeTable> = {
    caye_goals: goals,
    caye_goal_dependencies: dependencies,
    caye_goal_metrics: metrics,
  }

  return {
    client: {
      from(table: string) {
        const t = tables[table]
        if (!t) throw new Error(`unmocked table: ${table}`)
        return t
      },
    },
    tables: { goals, dependencies, metrics },
  }
}
