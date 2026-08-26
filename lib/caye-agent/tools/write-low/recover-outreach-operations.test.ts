import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const status = vi.fn()
const resume = vi.fn()
const source = vi.fn()
const autosend = vi.fn()
const safetyRecover = vi.fn()
vi.mock('@/lib/outreach-operational-status', () => ({ getOutreachOperationalStatus: status }))
vi.mock('@/lib/outreach-pause-control', () => ({ resumeOwnerPausedOutreach: resume }))
vi.mock('@/lib/outreach-safety-recovery', () => ({ recoverOutreachSafetyIfAllowed: safetyRecover }))
vi.mock('@/app/api/caye/outreach-sourcing-scan/route', () => ({ runOutreachSourcingScan: source }))
vi.mock('@/app/api/caye/outreach-autosend-scan/route', () => ({ runOutreachAutosendScan: autosend }))

const { recoverOutreachOperations } = await import('./recover-outreach-operations')
const ctx = { workspaceId: 'ws-a', callerRole: 'founder' } as never
const base = (disposition: string, source = 'owner_manual') => ({ enabled: true, pause: { disposition, source }, sendsToday: { firstTouchRemaining: 50 } })

describe('recover_outreach_operations', () => {
  beforeEach(() => vi.clearAllMocks())

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

  it('returns the deterministic blocker without owner approval when bounce recovery is denied', async () => {
    status.mockResolvedValue(base('safety_active', 'bounce_safety'))
    safetyRecover.mockResolvedValue({ recovered: false, decision: { blockers: ['active_bounce_threshold'], evidence: {} } })
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(result.data).toMatchObject({ recovered: false, blocker: 'active_bounce_threshold' })
    expect(source).not.toHaveBeenCalled()
    expect(autosend).not.toHaveBeenCalled()
  })

  it('runs ordinary sourcing and autosend only after an actual bounce recovery mutation succeeds', async () => {
    status.mockResolvedValue(base('safety_recovery_not_supported', 'bounce_safety'))
    safetyRecover.mockResolvedValue({ recovered: true, decision: { allowed: true, blockers: [], evidence: { pauseGeneration: 'pause-1' } } })
    source.mockResolvedValue({ status: 'accepted', already_queued: false })
    autosend.mockResolvedValue({ first_touch_sent: 0, errors: [] })
    const result = await recoverOutreachOperations.execute({}, ctx)
    expect(safetyRecover).toHaveBeenCalledWith('ws-a', 'founder')
    expect(source).toHaveBeenCalledOnce()
    expect(autosend).toHaveBeenCalledOnce()
    expect(result.data).toMatchObject({ recovered: true, resumed: true, recovery: { allowed: true } })
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
