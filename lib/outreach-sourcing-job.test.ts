import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const sourceLeadsMock = vi.fn()
vi.mock('./outreach-sourcing', () => ({ sourceLeads: (...args: unknown[]) => sourceLeadsMock(...args) }))

/** Chainable, thenable stub matching the subset of the supabase-js query
 *  builder this job calls: select/eq/is/upsert/update all return the same
 *  object so any chain order resolves, and awaiting it resolves `result`. */
function chain<T>(result: T) {
  const obj = {
    select: () => obj,
    eq: () => obj,
    is: () => obj,
    not: () => obj,
    order: () => obj,
    limit: () => obj,
    then: (resolve: (v: T) => unknown) => Promise.resolve(result).then(resolve),
  }
  return obj
}

const ACTIVE_TARGETS = [
  { id: 'nassau-tours', vertical: 'tour operator', region: 'Nassau, Bahamas', priority: 10, last_sourced_at: null },
  { id: 'freeport-tours', vertical: 'tour operator', region: 'Freeport, Bahamas', priority: 15, last_sourced_at: null },
  { id: 'exuma-tours', vertical: 'tour operator', region: 'Exuma, Bahamas', priority: 20, last_sourced_at: null },
]

function makeDb(opts: {
  unsentSupply: number
  targets?: typeof ACTIVE_TARGETS
  upsertInsertedCount?: (rows: Array<{ lead_email: string }>) => number
}) {
  const updateCalls: string[] = []
  const upsertCalls: Array<{ vertical: string; count: number }> = []
  const targets = opts.targets ?? ACTIVE_TARGETS

  const from = vi.fn((table: string) => {
    if (table === 'outreach_leads') {
      return {
        select: (_cols: string, selectOpts?: { head?: boolean }) => {
          if (selectOpts?.head) return chain({ count: opts.unsentSupply, error: null })
          return chain({ data: [], error: null })
        },
        upsert: (rows: Array<{ lead_email: string; business_name: string | null }>) => {
          const inserted = opts.upsertInsertedCount ? opts.upsertInsertedCount(rows) : rows.length
          upsertCalls.push({ vertical: rows[0]?.business_name ?? '', count: inserted })
          return { select: () => chain({ data: Array.from({ length: inserted }, (_, i) => ({ id: `lead-${i}` })), error: null }) }
        },
      }
    }
    if (table === 'outreach_sourcing_targets') {
      return {
        select: () => chain({ data: targets, error: null }),
        update: (patch: { last_sourced_at: string }) => ({
          eq: (_col: string, id: string) => {
            updateCalls.push(id)
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    }
    throw new Error(`unexpected table ${table}`)
  })

  return { from, updateCalls, upsertCalls }
}

vi.mock('./supabase-server', () => ({ createServiceClient: () => dbRef.current }))

let dbRef: { current: ReturnType<typeof makeDb> }

beforeEach(() => {
  sourceLeadsMock.mockReset()
})

describe('runOutreachSourcingJob', () => {
  it('skips sourcing entirely once the unsent buffer already covers the daily cap', async () => {
    dbRef = { current: makeDb({ unsentSupply: 50 }) }
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1')
    expect(result.status).toBe('skip')
    expect(sourceLeadsMock).not.toHaveBeenCalled()
  })

  it('rotates across multiple active targets in one run when the buffer is low (regression: CAY-98)', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => [
      { business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null },
    ])
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1') as { targets_attempted: number; targets_run: Array<{ target_id: string }> }

    // All three active targets get attempted in one run — the pre-fix job
    // only ever attempted the single top-priority target per invocation.
    expect(result.targets_attempted).toBe(3)
    expect(result.targets_run.map((t) => t.target_id).sort()).toEqual(
      ['exuma-tours', 'freeport-tours', 'nassau-tours'].sort()
    )
    expect(dbRef.current.updateCalls.sort()).toEqual(['exuma-tours', 'freeport-tours', 'nassau-tours'].sort())
  })

  it('stops rotating once the buffer covers the daily cap mid-run', async () => {
    dbRef = { current: makeDb({ unsentSupply: 40 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => [
      { business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null },
      { business_name: `${vertical} in ${region} 2`, phone: null, website: null, email: `lead2-${region}@example.com`, address: null },
      { business_name: `${vertical} in ${region} 3`, phone: null, website: null, email: `lead3-${region}@example.com`, address: null },
      { business_name: `${vertical} in ${region} 4`, phone: null, website: null, email: `lead4-${region}@example.com`, address: null },
      { business_name: `${vertical} in ${region} 5`, phone: null, website: null, email: `lead5-${region}@example.com`, address: null },
    ])
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1') as { targets_attempted: number }
    // 40 + 5(one target) = 45 (< cap), 45 + 5 (two targets) = 50 (>= cap) -> stop after 2 targets.
    expect(result.targets_attempted).toBe(2)
  })

  it('isolates a single target failure so the rest of the rotation still runs', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => {
      if (region === 'Freeport, Bahamas') throw new Error('places api 500')
      return [{ business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null }]
    })
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1') as { targets_run: Array<{ target_id: string; error?: string; inserted: number }> }
    expect(result.targets_run).toHaveLength(3)
    const freeport = result.targets_run.find((t) => t.target_id === 'freeport-tours')!
    expect(freeport.error).toContain('places api 500')
    expect(freeport.inserted).toBe(0)
    const nassau = result.targets_run.find((t) => t.target_id === 'nassau-tours')!
    expect(nassau.error).toBeUndefined()
    expect(nassau.inserted).toBe(1)
  })

  it('throws when every attempted target fails, so the cron run is correctly marked failed', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockRejectedValue(new Error('GOOGLE_MAPS_API_KEY not set'))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    await expect(runOutreachSourcingJob('ws-1')).rejects.toThrow('all 3 sourcing targets failed')
  })
})
