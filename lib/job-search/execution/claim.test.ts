import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const { claimApplicationForExecution, releaseExecutionClaim, reapStaleExecutionClaims, EXECUTION_LEASE_MS } = await import('./claim')

beforeEach(() => {
  fake = makeFakeSupabase({
    job_search_applications: [{ id: 'app-1', status: 'PREPARED', execution_attempt_count: 0 }],
  })
})

describe('claimApplicationForExecution — atomic compare-and-set (#194 scenario 1)', () => {
  it('claims a PREPARED application, moving it to APPLYING with a token', async () => {
    const claim = await claimApplicationForExecution('app-1')
    expect(claim).not.toBeNull()
    expect(fake.tables.job_search_applications[0].status).toBe('APPLYING')
    expect(fake.tables.job_search_applications[0].execution_claim_token).toBe(claim!.token)
  })

  it('refuses to claim an application that is not PREPARED', async () => {
    fake.tables.job_search_applications[0].status = 'NEEDS_HUMAN'
    const claim = await claimApplicationForExecution('app-1')
    expect(claim).toBeNull()
  })

  it('two concurrent claim attempts against the same application never both succeed', async () => {
    // The fake store's update-then-filter is synchronous per call, so this
    // proves the CODE PATH only allows one claim to see status='PREPARED'
    // match; the real backstop against true DB-level concurrency is
    // Postgres row locking on the same UPDATE ... WHERE clause (documented
    // in claim.ts), which the fake store cannot exercise, but the
    // compare-and-set logic itself — status flips before a second reader
    // could observe PREPARED — is what this test locks in.
    const [a, b] = await Promise.all([claimApplicationForExecution('app-1'), claimApplicationForExecution('app-1')])
    const claims = [a, b].filter((c) => c !== null)
    expect(claims).toHaveLength(1)
  })

  it('increments the attempt counter on each successful claim', async () => {
    await claimApplicationForExecution('app-1')
    expect(fake.tables.job_search_applications[0].execution_attempt_count).toBe(1)
    // Reset back to PREPARED to allow a second claim in this test.
    fake.tables.job_search_applications[0].status = 'PREPARED'
    fake.tables.job_search_applications[0].execution_claim_token = null
    await claimApplicationForExecution('app-1')
    expect(fake.tables.job_search_applications[0].execution_attempt_count).toBe(2)
  })
})

describe('releaseExecutionClaim — only the current lease holder may release (#194)', () => {
  it('sets the final status and clears the claim fields', async () => {
    const claim = await claimApplicationForExecution('app-1')
    await releaseExecutionClaim(claim!, 'SUBMITTED', { submitted_at: '2026-01-01T00:00:00.000Z' })
    const row = fake.tables.job_search_applications[0]
    expect(row.status).toBe('SUBMITTED')
    expect(row.execution_claim_token).toBeNull()
    expect(row.submitted_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('a stale/mismatched token cannot release a live claim', async () => {
    const claim = await claimApplicationForExecution('app-1')
    await releaseExecutionClaim({ ...claim!, token: 'wrong-token' }, 'FAILED')
    expect(fake.tables.job_search_applications[0].status).toBe('APPLYING')
  })
})

describe('reapStaleExecutionClaims — crash recovery routes to NEEDS_HUMAN, never a silent retry (#194 scenario 22)', () => {
  it('a live (in-window) claim is never touched', async () => {
    await claimApplicationForExecution('app-1')
    const reaped = await reapStaleExecutionClaims()
    expect(reaped).toBe(0)
    expect(fake.tables.job_search_applications[0].status).toBe('APPLYING')
  })

  it('a claim older than the lease window is reaped to NEEDS_HUMAN, not silently reset to PREPARED', async () => {
    const claim = await claimApplicationForExecution('app-1')
    fake.tables.job_search_applications[0].execution_claimed_at = new Date(Date.now() - EXECUTION_LEASE_MS - 1000).toISOString()
    void claim

    const reaped = await reapStaleExecutionClaims()
    expect(reaped).toBe(1)
    const row = fake.tables.job_search_applications[0]
    expect(row.status).toBe('NEEDS_HUMAN')
    expect(row.status).not.toBe('PREPARED')
    expect(row.execution_claim_token).toBeNull()
    expect(String(row.needs_human_reason)).toMatch(/crashed|expired/i)
  })

  it('claiming again reaps any stale claim first, so a genuinely crashed worker never strands the application forever', async () => {
    await claimApplicationForExecution('app-1')
    fake.tables.job_search_applications[0].execution_claimed_at = new Date(Date.now() - EXECUTION_LEASE_MS - 1000).toISOString()

    // The application is now NEEDS_HUMAN after the stale claim is reaped —
    // it does NOT silently become claimable again, which is the entire
    // point: a human must look at it before any further attempt.
    const secondClaim = await claimApplicationForExecution('app-1')
    expect(secondClaim).toBeNull()
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
  })
})
