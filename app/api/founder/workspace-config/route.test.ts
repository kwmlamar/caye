import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({}),
  createServerClient: () => ({ auth: { getUser: () => Promise.resolve({ data: { user: { id: 'founder-1' } } }) } }),
}))
vi.mock('@/lib/founder', () => ({ isFounderUserId: (id: string) => id === 'founder-1' }))

const pauseOutreachForOwner = vi.fn()
const resumeOwnerPausedOutreach = vi.fn()
const founderOverrideResolvedBounceSafetyPause = vi.fn()
vi.mock('@/lib/outreach-pause-control', () => ({
  pauseOutreachForOwner: (...args: unknown[]) => pauseOutreachForOwner(...args),
  resumeOwnerPausedOutreach: (...args: unknown[]) => resumeOwnerPausedOutreach(...args),
  founderOverrideResolvedBounceSafetyPause: (...args: unknown[]) => founderOverrideResolvedBounceSafetyPause(...args),
}))

const { PATCH } = await import('./route')

function patchReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/founder/workspace-config?workspaceId=ws-a', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/founder/workspace-config — outreach founder override', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not call the override when ordinary resume succeeds', async () => {
    resumeOwnerPausedOutreach.mockResolvedValue({ disposition: 'running', source: 'owner_manual' })
    const res = await PATCH(patchReq({ outreach_autosend_paused: false }))
    expect(res.status).toBe(200)
    expect(founderOverrideResolvedBounceSafetyPause).not.toHaveBeenCalled()
  })

  it('does not call the override without a written justification', async () => {
    resumeOwnerPausedOutreach.mockResolvedValue({ disposition: 'safety_recovery_not_supported', source: 'bounce_safety' })
    const res = await PATCH(patchReq({ outreach_autosend_paused: false }))
    expect(res.status).toBe(409)
    expect(founderOverrideResolvedBounceSafetyPause).not.toHaveBeenCalled()
  })

  it('calls the override only for resolved bounce_safety with justification', async () => {
    resumeOwnerPausedOutreach.mockResolvedValue({ disposition: 'safety_recovery_not_supported', source: 'bounce_safety' })
    founderOverrideResolvedBounceSafetyPause.mockResolvedValue({ disposition: 'running', source: 'bounce_safety' })
    const res = await PATCH(patchReq({ outreach_autosend_paused: false, outreach_override_justification: 'Bounce condition reviewed and resolved' }))
    expect(res.status).toBe(200)
    expect(founderOverrideResolvedBounceSafetyPause).toHaveBeenCalledWith('ws-a', 'Bounce condition reviewed and resolved')
  })

  it('surfaces an active bounce condition as a conflict', async () => {
    resumeOwnerPausedOutreach.mockResolvedValue({ disposition: 'safety_recovery_not_supported', source: 'bounce_safety' })
    founderOverrideResolvedBounceSafetyPause.mockResolvedValue({ disposition: 'safety_active', source: 'bounce_safety' })
    const res = await PATCH(patchReq({ outreach_autosend_paused: false, outreach_override_justification: 'reviewed' }))
    expect(res.status).toBe(409)
  })

  it('never invokes the override for unknown/provider/compliance pause classes', async () => {
    for (const source of ['unknown', 'provider_safety', 'compliance']) {
      resumeOwnerPausedOutreach.mockResolvedValueOnce({ disposition: source === 'unknown' ? 'unknown_blocked' : 'safety_recovery_not_supported', source })
      const res = await PATCH(patchReq({ outreach_autosend_paused: false, outreach_override_justification: 'reason' }))
      expect(res.status).toBe(409)
    }
    expect(founderOverrideResolvedBounceSafetyPause).not.toHaveBeenCalled()
  })
})
