/**
 * Job-search operator (CAY-194 / #194) — shared in-memory fake Supabase
 * client for this PR's test files. Test-only; not exercised by production
 * code. Supports exactly the query shapes used by preflight.ts, claim.ts,
 * rollout.ts, and executor.ts: eq/in/is/gte/lt filters, order+limit,
 * maybeSingle/single, count+head selects, and update/insert with an
 * optional trailing .select() (mirroring Supabase's RETURNING behavior).
 */
type Row = Record<string, unknown>
type FilterOp = 'eq' | 'in' | 'is' | 'gte' | 'lt'
type Filter = { type: FilterOp; col: string; val: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const cell = row[f.col]
    switch (f.type) {
      case 'eq':
        return cell === f.val
      case 'in':
        return Array.isArray(f.val) && f.val.includes(cell)
      case 'is':
        return f.val === null ? cell === null || cell === undefined : cell === f.val
      case 'gte':
        return cell !== undefined && cell !== null && (cell as string | number) >= (f.val as string | number)
      case 'lt':
        return cell !== undefined && cell !== null && (cell as string | number) < (f.val as string | number)
      default:
        return true
    }
  })
}

export function makeFakeSupabase(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }))
  let counter = 0

  function builder(table: string, mode: 'select' | 'update' | 'insert', payload?: Row | Row[], selectOpts?: { count?: string; head?: boolean }) {
    const filters: Filter[] = []
    let orderCol: string | null = null
    let orderAsc = true
    let limitN: number | null = null

    function compute(): Row[] {
      const store = (tables[table] ??= [])
      if (mode === 'update') {
        const matched = store.filter((r) => matches(r, filters))
        matched.forEach((r) => Object.assign(r, payload as Row))
        return matched
      }
      if (mode === 'insert') {
        const rowsIn = Array.isArray(payload) ? payload : [payload as Row]
        return rowsIn.map((r) => {
          const full = { id: `id_${counter++}`, ...r }
          store.push(full)
          return full
        })
      }
      let result = store.filter((r) => matches(r, filters))
      if (orderCol) {
        const col = orderCol
        result = [...result].sort((a, b) => {
          const av = a[col] as string | number
          const bv = b[col] as string | number
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return orderAsc ? cmp : -cmp
        })
      }
      if (limitN !== null) result = result.slice(0, limitN)
      return result
    }

    const api = {
      eq(col: string, val: unknown) {
        filters.push({ type: 'eq', col, val })
        return api
      },
      in(col: string, val: unknown[]) {
        filters.push({ type: 'in', col, val })
        return api
      },
      is(col: string, val: unknown) {
        filters.push({ type: 'is', col, val })
        return api
      },
      gte(col: string, val: unknown) {
        filters.push({ type: 'gte', col, val })
        return api
      },
      lt(col: string, val: unknown) {
        filters.push({ type: 'lt', col, val })
        return api
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col
        orderAsc = opts?.ascending ?? true
        return api
      },
      limit(n: number) {
        limitN = n
        return api
      },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode === 'select') selectOpts = opts
        return api
      },
      async maybeSingle() {
        const rows = compute()
        return { data: rows[0] ?? null, error: null }
      },
      async single() {
        const rows = compute()
        return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows found' } }
      },
      then(resolve: (v: { data: Row[] | null; error: null } | { count: number; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => {
            if (mode === 'select' && selectOpts?.head) {
              return { count: compute().length, error: null }
            }
            return { data: compute(), error: null }
          })
          .then(resolve, reject)
      },
    }
    return api
  }

  const client = {
    from(table: string) {
      return {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          return builder(table, 'select', undefined, opts)
        },
        update(patch: Row) {
          return builder(table, 'update', patch)
        },
        insert(rowOrRows: Row | Row[]) {
          return builder(table, 'insert', rowOrRows)
        },
      }
    },
    async rpc(name: string, args: { p_application_id: string; p_claim_token: string }) {
      if (name !== 'reserve_job_search_submission_slot') return { data: null, error: { message: 'unknown rpc' } }
      const application = (tables.job_search_applications ?? []).find((row) => row.id === args.p_application_id)
      if (!application || application.status !== 'APPLYING' || application.execution_claim_token !== args.p_claim_token) return { data: false, error: null }
      const settings = (tables.job_search_execution_settings ?? [])[0]
      const cap = typeof settings?.daily_submission_cap === 'number' ? settings.daily_submission_cap : 0
      const reservations = (tables.job_search_submission_reservations ??= [])
      if (reservations.some((row) => row.application_id === args.p_application_id) || reservations.length >= cap) return { data: false, error: null }
      reservations.push({ id: `reservation_${counter++}`, application_id: args.p_application_id, claim_token: args.p_claim_token, reservation_day: 'today' })
      return { data: true, error: null }
    },
  }

  return { client, tables }
}
