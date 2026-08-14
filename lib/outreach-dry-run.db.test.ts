import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const d = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip
const WORKSPACE = '7c0537ff-7864-4788-b090-61f561237974'

d('outreach selector dry run — live workspace', () => {
  it('reaches the previously starved sourced leads without sending', async () => {
    const { dryRunOutreachSelection } = await import('./outreach-dry-run')
    const result = await dryRunOutreachSelection(WORKSPACE, new Date('2026-08-13T22:00:00Z'))
    expect(result.selected.filter((row) => row.action.kind === 'send_first_touch')).toHaveLength(11)
    expect(result.excluded.invalid_email).toBe(1)
    expect(result.selected.every((row) => row.action.kind !== 'do_nothing')).toBe(true)
    console.log('[live-outreach-dry-run]', JSON.stringify(result))
  })
})
