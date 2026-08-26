import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import {
  applyActiveWorkPrecedence,
  isActiveWorkCorrection,
  seedActiveWork,
} from './active-work'

describe('active work precedence — Jeff Dworkin regression', () => {
  const initial = `Draft a thank you to jeffd@jldhomes.com: Hi,
If you have pictures, please share them with us.`

  it('keeps supplied draft content as artifact material', () => {
    const work = seedActiveWork(initial, { kind: 'edit', instruction: initial })
    expect(work).toMatchObject({
      entityRef: 'jeffd@jldhomes.com',
      operation: 'customer_reply_draft',
      status: 'editing',
    })
    expect(work?.artifact).toContain('If you have pictures, please share them with us.')
  })

  it('makes a correction resolve to the active customer instead of stale held items', () => {
    const work = seedActiveWork(initial, { kind: 'edit', instruction: initial })!
    const correction = "don't say husband as jeff is a male and also mention the driver james edden"
    expect(isActiveWorkCorrection(correction, work)).toBe(true)
    expect(applyActiveWorkPrecedence({ kind: 'unclear', ask_back: 'which item — 1 kelsey or 2 jonathan?' }, correction, work)).toEqual({
      kind: 'edit',
      item_ref: 'jeffd@jldhomes.com',
      instruction: correction,
    })
  })

  it('lets an explicit new customer override the active work', () => {
    const work = seedActiveWork(initial, { kind: 'edit', instruction: initial })!
    expect(isActiveWorkCorrection('For jonathan@example.com, change the snorkeling reply', work)).toBe(false)
  })

  it('does not manufacture a target for a genuinely ambiguous request', () => {
    expect(applyActiveWorkPrecedence({ kind: 'unclear', ask_back: 'which item?' }, 'change the time to 10', null)).toEqual({
      kind: 'unclear', ask_back: 'which item?',
    })
  })
})
