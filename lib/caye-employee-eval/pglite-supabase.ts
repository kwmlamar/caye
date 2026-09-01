import { PGlite } from '@electric-sql/pglite'

type DbError = { message: string }
type QueryResult<T = unknown> = { data: T | null; error: DbError | null }

type Filter =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'is'; column: string; value: null }
  | { kind: 'in'; column: string; value: unknown[] }
  | { kind: 'ilike'; column: string; value: string }

type ParameterCast = 'jsonb' | undefined

const JSONB_COLUMNS = new Set([
  'metadata',
  'source_metadata',
  'provenance',
  'details',
  'conversation_ids',
])

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`)
  return `"${value}"`
}

function selectList(value: string): string {
  if (value.trim() === '*') return '*'
  return value.split(',').map((part) => identifier(part.trim())).join(', ')
}

function parameter(value: unknown, params: unknown[], cast?: ParameterCast): string {
  params.push(cast === 'jsonb' ? JSON.stringify(value ?? null) : value)
  const slot = `$${params.length}`
  return cast === 'jsonb' ? `${slot}::jsonb` : slot
}

function columnParameter(column: string, value: unknown, params: unknown[]): string {
  return parameter(value, params, JSONB_COLUMNS.has(column) ? 'jsonb' : undefined)
}

export class PGliteSupabaseClient {
  constructor(readonly db: PGlite) {}

  from(table: string): QueryBuilder {
    return new QueryBuilder(this.db, table)
  }

  rpc(name: string, args: Record<string, unknown>): RpcBuilder {
    return new RpcBuilder(this.db, name, args)
  }
}

class QueryBuilder implements PromiseLike<QueryResult<any>> {
  private operation: 'select' | 'insert' | 'update' = 'select'
  private projection = '*'
  private returning: string | null = null
  private payload: Record<string, unknown> | null = null
  private filters: Filter[] = []
  private orderBy: { column: string; ascending: boolean } | null = null
  private rowLimit: number | null = null

  constructor(private readonly db: PGlite, private readonly table: string) {}

  select(columns = '*'): this {
    if (this.operation === 'insert' || this.operation === 'update') this.returning = columns
    else this.projection = columns
    return this
  }

  insert(values: Record<string, unknown>): this {
    this.operation = 'insert'
    this.payload = values
    return this
  }

  update(values: Record<string, unknown>): this {
    this.operation = 'update'
    this.payload = values
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }

  is(column: string, value: null): this {
    this.filters.push({ kind: 'is', column, value })
    return this
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: 'in', column, value })
    return this
  }

  ilike(column: string, value: string): this {
    this.filters.push({ kind: 'ilike', column, value })
    return this
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false }
    return this
  }

  limit(value: number): this {
    this.rowLimit = Math.max(0, Math.floor(value))
    return this
  }

  async maybeSingle(): Promise<QueryResult<any>> {
    const result = await this.execute()
    if (result.error) return result
    const rows = Array.isArray(result.data) ? result.data : []
    if (rows.length > 1) return { data: null, error: { message: `Expected zero or one row, received ${rows.length}` } }
    return { data: rows[0] ?? null, error: null }
  }

  async single(): Promise<QueryResult<any>> {
    const result = await this.execute()
    if (result.error) return result
    const rows = Array.isArray(result.data) ? result.data : []
    if (rows.length !== 1) return { data: null, error: { message: `Expected one row, received ${rows.length}` } }
    return { data: rows[0], error: null }
  }

  then<TResult1 = QueryResult<any>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private where(params: unknown[]): string {
    if (!this.filters.length) return ''
    const clauses = this.filters.map((filter) => {
      const col = identifier(filter.column)
      if (filter.kind === 'is') return `${col} is null`
      if (filter.kind === 'ilike') return `${col} ilike ${parameter(filter.value, params)}`
      if (filter.kind === 'in') {
        if (!filter.value.length) return 'false'
        const slots = filter.value.map((value) => parameter(value, params))
        return `${col} in (${slots.join(', ')})`
      }
      return `${col} = ${parameter(filter.value, params)}`
    })
    return ` where ${clauses.join(' and ')}`
  }

  private async execute(): Promise<QueryResult<any>> {
    try {
      const params: unknown[] = []
      const table = identifier(this.table)
      let sql: string

      if (this.operation === 'select') {
        sql = `select ${selectList(this.projection)} from ${table}${this.where(params)}`
        if (this.orderBy) sql += ` order by ${identifier(this.orderBy.column)} ${this.orderBy.ascending ? 'asc' : 'desc'}`
        if (this.rowLimit != null) sql += ` limit ${this.rowLimit}`
      } else if (this.operation === 'insert') {
        const entries = Object.entries(this.payload ?? {})
        const columns = entries.map(([key]) => identifier(key)).join(', ')
        const slots = entries.map(([key, value]) => columnParameter(key, value, params)).join(', ')
        sql = `insert into ${table} (${columns}) values (${slots})`
        if (this.returning) sql += ` returning ${selectList(this.returning)}`
      } else {
        const entries = Object.entries(this.payload ?? {})
        const assignments = entries.map(([key, value]) => `${identifier(key)} = ${columnParameter(key, value, params)}`).join(', ')
        sql = `update ${table} set ${assignments}${this.where(params)}`
        if (this.returning) sql += ` returning ${selectList(this.returning)}`
      }

      const result = await this.db.query(sql, params as never[])
      if (this.operation === 'select' || this.returning) return { data: result.rows, error: null }
      return { data: null, error: null }
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }
}

class RpcBuilder {
  constructor(private readonly db: PGlite, private readonly name: string, private readonly args: Record<string, unknown>) {}

  async single(): Promise<QueryResult<any>> {
    try {
      if (this.name !== 'write_typed_business_memory_atomic') {
        return { data: null, error: { message: `Unsupported Employee Eval RPC: ${this.name}` } }
      }
      const ordered = [
        'p_workspace_id','p_category','p_fact','p_source','p_created_by','p_service_id','p_canonical_key','p_expires_at','p_supersede_id',
        'p_memory_type','p_subject_type','p_subject_id','p_knowledge_mode','p_confidence','p_valid_from','p_sensitivity','p_authority_kind',
        'p_provenance','p_contradicts_fact_id','p_correction_of_fact_id',
      ]
      const params: unknown[] = []
      const slots = ordered.map((key) => parameter(this.args[key] ?? null, params, key === 'p_provenance' ? 'jsonb' : undefined))
      const result = await this.db.query(
        `select * from ${identifier(this.name)}(${slots.join(', ')})`,
        params as never[],
      )
      if (result.rows.length !== 1) return { data: null, error: { message: `RPC returned ${result.rows.length} rows` } }
      return { data: result.rows[0], error: null }
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }
}
