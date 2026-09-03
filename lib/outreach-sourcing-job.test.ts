import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const sourceLeadsMock = vi.fn()
vi.mock('./outreach-sourcing', async () => {
  const actual = await vi.importActual<typeof import('./outreach-sourcing')>('./outreach-sourcing')
  return {
    ...actual,
    sourceLeads: (...args: unknown[]) => sourceLeadsMock(...args),
  }
})

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

/** Wraps a plain array of leads (the old sourceLeads return shape) into the
 *  current SourceLeadsResult shape, so most tests below don't need to spell
 *  out rejectedNotIcp/consumed/totalResults every time. */
function sourceResult(leads: Array<{ business_name: string; phone: null; website: null; email: string; address: null; evidence?: string | null }>) {
  return { leads, rejectedNotIcp: 0, consumed: leads.length, totalResults: leads.length }
}

const ACTIVE_TARGETS = [
  { id: 'nassau-tours', vertical: 'tour operator', region: 'Nassau, Bahamas', priority: 10, last_sourced_at: null, query_variant_index: 0, result_offset: 0 },
  { id: 'freeport-tours', vertical: 'tour operator', region: 'Freeport, Bahamas', priority: 15, last_sourced_at: null, query_variant_index: 0, result_offset: 0 },
  { id: 'exuma-tours', vertical: 'tour operator', region: 'Exuma, Bahamas', priority: 20, last_sourced_at: null, query_variant_index: 0, result_offset: 0 },
]

function makeDb(opts: {
  unsentSupply: number
  targets?: typeof ACTIVE_TARGETS
  upsertInsertedCount?: (rows: Array<{ lead_email: string }>) => number
}) {
  const updateCalls: string[] = []
  const updatePatches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const upsertCalls: Array<{ vertical: string; count: number }> = []
  const upsertedRows: Array<{ lead_email: string; business_name: string | null; business_evidence?: string | null }> = []
  const targets = opts.targets ?? ACTIVE_TARGETS

  const from = vi.fn((table: string) => {
    if (table === 'outreach_leads') {
      return {
        select: (_cols: string, selectOpts?: { head?: boolean }) => {
          if (selectOpts?.head) return chain({ count: opts.unsentSupply, error: null })
          return chain({ data: [], error: null })
        },
        upsert: (rows: Array<{ lead_email: string; business_name: string | null; business_evidence?: string | null }>) => {
          const inserted = opts.upsertInsertedCount ? opts.upsertInsertedCount(rows) : rows.length
          upsertCalls.push({ vertical: rows[0]?.business_name ?? '', count: inserted })
          upsertedRows.push(...rows)
          return { select: () => chain({ data: Array.from({ length: inserted }, (_, i) => ({ id: `lead-${i}` })), error: null }) }
        },
      }
    }
    if (table === 'outreach_sourcing_targets') {
      return {
        select: () => chain({ data: targets, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updateCalls.push(id)
            updatePatches.push({ id, patch })
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    }
    throw new Error(`unexpected table ${table}`)
  })

  return { from, updateCalls, updatePatches, upsertCalls, upsertedRows }
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
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) =>
      sourceResult([{ business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null }])
    )
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
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) =>
      sourceResult([1, 2, 3, 4, 5].map((n) => ({
        business_name: `${vertical} in ${region} ${n}`, phone: null, website: null, email: `lead${n}-${region}@example.com`, address: null,
      })))
    )
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1') as { targets_attempted: number }
    // 40 + 5(one target) = 45 (< cap), 45 + 5 (two targets) = 50 (>= cap) -> stop after 2 targets.
    expect(result.targets_attempted).toBe(2)
  })

  it('isolates a single target failure so the rest of the rotation still runs', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => {
      if (region === 'Freeport, Bahamas') throw new Error('places api 500')
      return sourceResult([{ business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null }])
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

  it('carries a sourced lead\'s scraped evidence through to the outreach_leads upsert', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => sourceResult([
      {
        business_name: `${vertical} in ${region}`, phone: null, website: null,
        email: `lead-${region}@example.com`, address: null,
        evidence: 'Family-run snorkeling and reef tours out of Freeport since 1998.',
      },
    ]))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    await runOutreachSourcingJob('ws-1')
    expect(dbRef.current.upsertedRows).toContainEqual(
      expect.objectContaining({ business_evidence: 'Family-run snorkeling and reef tours out of Freeport since 1998.' })
    )
  })

  it('inserts a null business_evidence when nothing was scraped, rather than an empty string', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async (vertical: string, region: string) => sourceResult([
      { business_name: `${vertical} in ${region}`, phone: null, website: null, email: `lead-${region}@example.com`, address: null, evidence: null },
    ]))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    await runOutreachSourcingJob('ws-1')
    expect(dbRef.current.upsertedRows).toContainEqual(expect.objectContaining({ business_evidence: null }))
  })

  it('surfaces rejected_not_icp separately from rejected_no_email in the run summary', async () => {
    dbRef = { current: makeDb({ unsentSupply: 1 }) }
    sourceLeadsMock.mockImplementation(async () => ({
      leads: [{ business_name: 'A Small Tour Co', phone: null, website: null, email: 'hi@small.example', address: null, evidence: null }],
      rejectedNotIcp: 4,
      consumed: 20,
      totalResults: 20,
    }))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    const result = await runOutreachSourcingJob('ws-1') as { total_rejected_not_icp: number; targets_run: Array<{ rejected_not_icp: number; found: number }> }
    expect(result.total_rejected_not_icp).toBe(12) // 4 per target x 3 targets
    expect(result.targets_run[0].rejected_not_icp).toBe(4)
    expect(result.targets_run[0].found).toBe(5) // 1 usable lead + 4 rejected-for-ICP, mirroring the old "found" semantics (successfully detail-fetched places)
  })

  it('passes the target\'s persisted query-variant string and offset through to sourceLeads', async () => {
    const targets = [
      { id: 'nassau-tours', vertical: 'tour operator', region: 'Nassau, Bahamas', priority: 10, last_sourced_at: null, query_variant_index: 2, result_offset: 20 },
    ]
    dbRef = { current: makeDb({ unsentSupply: 1, targets }) }
    sourceLeadsMock.mockImplementation(async () => sourceResult([]))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    await runOutreachSourcingJob('ws-1')

    // VERTICAL_QUERY_VARIANTS['tour operator'][2] === 'snorkel trip' (see outreach-sourcing.ts)
    expect(sourceLeadsMock).toHaveBeenCalledWith('snorkel trip', 'Nassau, Bahamas', 20, 20)
  })

  it('advances the persisted cursor on outreach_sourcing_targets after a run', async () => {
    const targets = [
      { id: 'nassau-tours', vertical: 'tour operator', region: 'Nassau, Bahamas', priority: 10, last_sourced_at: null, query_variant_index: 0, result_offset: 0 },
    ]
    dbRef = { current: makeDb({ unsentSupply: 1, targets }) }
    // Full 20-result page out of a 20-result total -> exhausted, rolls to the next variant at offset 0.
    sourceLeadsMock.mockImplementation(async () => ({ leads: [], rejectedNotIcp: 0, consumed: 20, totalResults: 20 }))
    const { runOutreachSourcingJob } = await import('./outreach-sourcing-job')
    await runOutreachSourcingJob('ws-1')

    const patch = dbRef.current.updatePatches.find((p) => p.id === 'nassau-tours')!.patch
    expect(patch.query_variant_index).toBe(1)
    expect(patch.result_offset).toBe(0)
  })
})
