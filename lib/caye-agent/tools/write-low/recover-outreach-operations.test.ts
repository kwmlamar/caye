import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const status = vi.fn()
const resume = vi.fn()
const source = vi.fn()
const autosend = vi.fn()
vi.mock('@/lib/outreach-operational-status', () => ({ getOutreachOperationalStatus: status }))
vi.mock('@/lib/outreach-pause-control', () => ({ resumeOwnerPausedOutreach: resume }))
vi.mock('@/app/api/caye/outreach-sourcing-scan/route', () => ({ runOutreachSourcingScan: source }))
vi.mock('@/app/api/caye/outreach-autosend-scan/route', () => ({ runOutreachAutosendScan: autosend }))

const { recoverOutreachOperations } = await import('./recover-outreach-operations')
const ctx = { workspaceId: 'ws-a', callerRole: 'founder' } as never
const base = (disposition: string) => ({ enabled: true, pause: { disposition }, sendsToday: { firstTouchRemaining: 50 } })

describe('recover_outreach_operations', () => {
  it('does not resume or run work while a bounce safety stop is active', async () => {
    status.mockResolvedValue(base('safety_locked'))
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(result.data).toMatchObject({ recovered: false, blocker: 'safety_locked' })
    expect(resume).not.toHaveBeenCalled()
    expect(source).not.toHaveBeenCalled()
    expect(autosend).not.toHaveBeenCalled()
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
