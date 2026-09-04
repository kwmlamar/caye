import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabaseClient, type FakeSupabaseClient } from '@/lib/supabase-test-support/fake-supabase-client'
vi.mock('server-only', () => ({}))

const status = vi.fn()
const resume = vi.fn()
const source = vi.fn()
const autosend = vi.fn()
vi.mock('@/lib/outreach-operational-status', () => ({ getOutreachOperationalStatus: status }))
vi.mock('@/lib/outreach-pause-control', () => ({ resumeOwnerPausedOutreach: resume }))
vi.mock('@/app/api/caye/outreach-sourcing-scan/route', () => ({ runOutreachSourcingScan: source }))
vi.mock('@/app/api/caye/outreach-autosend-scan/route', () => ({ runOutreachAutosendScan: autosend }))

// Repository audit, 2026-09-03: same root cause confirm-pending-action.test.ts
// had (see that file's SAFETY NOTE) — recover-outreach-operations.ts calls
// resolveWorkspaceDecisionAuthority (lib/decision-authority.ts, CAY-28 /
// commit 5633cca7) before doing anything else, which queries
// operator_allowlist and operator_authority_delegations. This file's ctx
// carried no Supabase mock and no operatorId at all, so createServiceClient
// threw "Missing NEXT_PUBLIC_SUPABASE_URL..." on every test before the
// scenario under test (bounce safety stop / historical pause / owner
// resume) was ever reached. Migrated to the shared FakeSupabaseClient, with
// a verified founder principal holding the 'business.outreach.control'
// scope decision-authority.ts's requiredAuthorityForDomain('outreach_control')
// requires, so the real authority-resolution code runs and authorizes ctx's
// operator instead of being bypassed.
let client: FakeSupabaseClient

function makeFakeSupabase() {
  client = createFakeSupabaseClient()
  client.seed('operator_allowlist', [
    {
      id: 30,
      workspace_id: 'ws-a',
      name: 'Founder',
      role: 'founder',
      verified_at: '2026-01-01T00:00:00.000Z',
      decision_scopes: ['business.outreach.control'],
    },
  ])
  client.seed('operator_authority_delegations', [])
  return client
}

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => client }))

const { recoverOutreachOperations } = await import('./recover-outreach-operations')
const ctx = { workspaceId: 'ws-a', callerRole: 'founder', operatorId: 30 } as never
const base = (disposition: string) => ({ enabled: true, pause: { disposition }, sendsToday: { firstTouchRemaining: 50 } })

describe('recover_outreach_operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    makeFakeSupabase()
  })

  it('does not resume or run work while a bounce safety stop is active', async () => {
    status.mockResolvedValue(base('safety_active'))
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(result.data).toMatchObject({ recovered: false, blocker: 'safety_active' })
    expect(resume).not.toHaveBeenCalled()
    expect(source).not.toHaveBeenCalled()
    expect(autosend).not.toHaveBeenCalled()
  })

  it('keeps a historical safety pause held when no deterministic recovery proof exists', async () => {
    status.mockResolvedValue(base('safety_recovery_not_supported'))
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(result.data).toMatchObject({ recovered: false, blocker: 'safety_recovery_not_supported' })
    expect(resume).not.toHaveBeenCalled()
    expect(source).not.toHaveBeenCalled()
  })

  it('resumes only an owner pause, then uses the existing sourcing and autosend paths', async () => {
    status.mockResolvedValue(base('owner_resumable'))
    resume.mockResolvedValue({ disposition: 'running' })
    source.mockResolvedValue({ status: 'accepted', already_queued: false })
    autosend.mockResolvedValue({ first_touch_sent: 2, errors: [] })
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(resume).toHaveBeenCalledWith('ws-a', 'founder')
    expect(source).toHaveBeenCalledOnce()
    expect(autosend).toHaveBeenCalledOnce()
    expect(result.data).toMatchObject({ recovered: true, resumed: true, autosend: { first_touch_sent: 2 } })
  })
})
