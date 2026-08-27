import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import {
  applyActiveWorkPrecedence,
  isActiveWorkCorrection,
  seedActiveWork,
  updateActiveWork,
  intentWithActiveWork,
  activeWorkFromIntent,
  loadActiveWork,
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

  it('persists the revised artifact on the exact Jeff work record', async () => {
    const work = { ...seedActiveWork(initial, { kind: 'edit', instruction: initial })!, sourceMessageId: 'jeff-work' }
    const updates: Record<string, unknown>[] = []
    let query: any
    query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: 'jeff-work', intent: intentWithActiveWork({ kind: 'edit', instruction: initial }, work) } }),
      update: (value: Record<string, unknown>) => { updates.push(value); return query },
    }
    const ok = await updateActiveWork({
      supabase: { from: () => query }, workspaceId: 'ws', operatorId: 1, work,
      artifact: 'Hi Jeff, James Edden made the day memorable.', status: 'ready',
    })
    expect(ok).toBe(true)
    expect(JSON.stringify(updates[0])).not.toMatch(/husband/)
    expect(JSON.stringify(updates[0])).toMatch(/James Edden/)
  })

  it('cannot let a delayed Jeff completion mutate newer Bob work', async () => {
    const jeff = { ...seedActiveWork(initial, { kind: 'edit', instruction: initial })!, sourceMessageId: 'jeff-work' }
    const bob = { ...seedActiveWork('Draft a thank you to bob@example.com: Hi Bob', { kind: 'edit', instruction: 'x' })!, sourceMessageId: 'bob-work' }
    const updates: Record<string, unknown>[] = []
    let query: any
    query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: 'bob-work', intent: intentWithActiveWork({ kind: 'edit', instruction: 'x' }, bob) } }),
      update: (value: Record<string, unknown>) => { updates.push(value); return query },
    }
    const ok = await updateActiveWork({ supabase: { from: () => query }, workspaceId: 'ws', operatorId: 1, work: jeff, status: 'completed' })
    expect(ok).toBe(false)
    expect(updates).toHaveLength(0)
  })
})

describe('active work — "uncertain" status (CAY-139, 2026-08-26 draft-execution ambiguity)', () => {
  it('accepts "uncertain" as a valid persisted status', () => {
    const work = activeWorkFromIntent({
      active_work: {
        entityRef: 'jeffd@jldhomes.com',
        operation: 'customer_reply_draft',
        artifact: 'draft text',
        status: 'uncertain',
        createdAt: '2026-08-26T00:00:00Z',
      },
    })
    expect(work?.status).toBe('uncertain')
  })

  it('rejects an unrecognised status the same way it always has', () => {
    const work = activeWorkFromIntent({
      active_work: {
        entityRef: 'jeffd@jldhomes.com',
        operation: 'customer_reply_draft',
        artifact: 'draft text',
        status: 'bogus_status',
        createdAt: '2026-08-26T00:00:00Z',
      },
    })
    expect(work).toBeNull()
  })

  it('treats "uncertain" as still-active (not completed) so loadActiveWork resumes it', async () => {
    const row = {
      id: 'jeff-uncertain',
      created_at: new Date().toISOString(),
      intent: {
        active_work: {
          entityRef: 'jeffd@jldhomes.com',
          operation: 'customer_reply_draft',
          artifact: 'the exact attempted draft',
          status: 'uncertain',
          createdAt: new Date().toISOString(),
        },
      },
    }
    const query: any = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      order: () => query,
      limit: async () => ({ data: [row] }),
    }
    const work = await loadActiveWork({ supabase: { from: () => query }, workspaceId: 'ws', operatorId: 1 })
    expect(work?.status).toBe('uncertain')
    expect(work?.artifact).toBe('the exact attempted draft')
  })

  it('can transition an "uncertain" record to "completed" on a later successful attempt', async () => {
    const work = { ...seedActiveWork('Draft a thank you to jeffd@jldhomes.com: hi', { kind: 'edit', instruction: 'x' })!, sourceMessageId: 'jeff-work', status: 'uncertain' as const }
    const updates: Record<string, unknown>[] = []
    let query: any
    query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: 'jeff-work', intent: intentWithActiveWork({ kind: 'edit', instruction: 'x' }, work) } }),
      update: (value: Record<string, unknown>) => { updates.push(value); return query },
    }
    const ok = await updateActiveWork({
      supabase: { from: () => query }, workspaceId: 'ws', operatorId: 1, work,
      artifact: 'reconciled/reattempted draft text', status: 'completed',
    })
    expect(ok).toBe(true)
    const active = (updates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('completed')
    expect(active.artifact).toBe('reconciled/reattempted draft text')
  })
})
