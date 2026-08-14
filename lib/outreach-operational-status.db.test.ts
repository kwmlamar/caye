import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const enabled = process.env.RUN_DB_TESTS === '1'
const d = enabled ? describe : describe.skip
const WORKSPACE = '7c0537ff-7864-4788-b090-61f561237974'

d('outreach operational status — live workspace', () => {
  it('matches the authoritative workspace and outreach state', async () => {
    const { getOutreachOperationalStatus } = await import('./outreach-operational-status')
    const status = await getOutreachOperationalStatus(WORKSPACE)
    expect(status.workspaceId).toBe(WORKSPACE)
    expect(status.timezone).toBe('America/Nassau')
    expect(status.enabled).toBe(true)
    expect(status.paused).toBe(false)
    expect(status.sendsToday.dailyLimit).toBe(50)
    expect(status.provider.connected).toBe(true)
    expect(status.lastScan.ranAt).toBeTruthy()
    expect(status.lastSourcing.ranAt).toBeTruthy()
    expect(status.sourcing.availableCandidates).toBe(11)
    expect(status.sourcing.lastRejected).toBe(6)
    expect(status.sourcing.lastDuplicates).toBe(2)
    expect(status.reasonNoOutreach).toBeTruthy()
    console.log('[live-outreach-status]', JSON.stringify(status))
  })
})
