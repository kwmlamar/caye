import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * The full attention lifecycle, end to end, against the real database.
 *
 * Every individual piece has a unit test. This asserts the SEQUENCE, because
 * the 2026-08-12 failure was not in any one step — observe worked, notify
 * worked, the read worked — it was that nothing tied them together, so the
 * second composer had no idea the first had spoken.
 *
 *   1. discover  2. record  3. notify  4. seen again  5. recognised as told
 *   6. nothing changed  7. NOT re-raised as new  8. state changes
 *   9. fingerprint differs  10. surfaced again, updated  11. resolved
 *   12. gone from outstanding
 *
 * OPT-IN: RUN_DB_TESTS=1 npx vitest run lib/owner-attention.lifecycle.db.test.ts
 */

const ENABLED = process.env.RUN_DB_TESTS === '1'
const d = ENABLED ? describe : describe.skip

const WS = '00000000-dead-4000-a000-000000000002'
const CONV = 'conv-lifecycle-1'

d('owner attention — the whole lifecycle', () => {
  let mod: typeof import('./owner-attention')
  let supabase: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>

  beforeAll(async () => {
    mod = await import('./owner-attention')
    const { createServiceClient } = await import('@/lib/supabase-server')
    supabase = createServiceClient()
    await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS)
  })

  afterAll(async () => {
    if (supabase) await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS)
  })

  it('runs discover → notify → re-scan → change → resolve without ever lying to the owner', async () => {
    const subject = { workspaceId: WS, subjectType: mod.SUBJECT_CONVERSATION, subjectId: CONV }

    // ── 1 + 2. Caye discovers the item and records it ────────────────────
    await mod.observeAttentionItem({
      ...subject,
      conversationId: null,
      title: 'Ruslan Prakapovich — B2B partnership',
      priority: 'decision',
      nextAction: 'Waiting on your call',
      fingerprintParts: ['sensitive', null, 'wants group rates'],
    })

    let delta = await mod.loadAttentionDelta({ workspaceId: WS })
    expect(delta.unreported.map((i) => i.subjectId), 'step 2: recorded as new').toContain(CONV)
    expect(delta.allClear, 'step 2: owner is not clear').toBe(false)

    // ── 3. Caye notifies the owner ───────────────────────────────────────
    await mod.markAttentionNotified({ ...subject, summary: 'B2B enquiry — needs your call.' })

    // ── 4 + 5 + 6 + 7. A later scan sees the SAME item, unchanged ────────
    // This is the exact moment the morning digest ran on 2026-08-12 and said
    // "no new threads need your immediate attention" about this very item.
    await mod.observeAttentionItem({
      ...subject,
      conversationId: null,
      title: 'Ruslan Prakapovich — B2B partnership',
      priority: 'decision',
      nextAction: 'Waiting on your call',
      fingerprintParts: ['sensitive', null, 'wants group rates'],
    })

    delta = await mod.loadAttentionDelta({ workspaceId: WS })
    expect(delta.unreported, 'step 7: NOT re-raised as new').toHaveLength(0)
    expect(delta.changed, 'step 6: nothing changed').toHaveLength(0)
    expect(delta.unchanged.map((i) => i.subjectId), 'step 5: recognised as already told').toContain(CONV)
    // And still not clear — the item is open, it is just not news.
    expect(delta.allClear, 'step 7: still not clear').toBe(false)

    // The composer can see its own prior words, so it gives a delta rather
    // than re-explaining from scratch.
    expect(delta.unchanged[0].lastNotifiedSummary).toBe('B2B enquiry — needs your call.')
    expect(delta.unchanged[0].notifyCount).toBe(1)

    const context = mod.renderAttentionContext(delta)
    expect(context).toMatch(/ALREADY TOLD, NOTHING CHANGED \(1\)/)
    expect(context).toMatch(/do NOT re-explain or re-raise as new/)
    expect(context).toMatch(/The owner is NOT clear/)

    // ── 8 + 9 + 10. The item genuinely changes ───────────────────────────
    await mod.observeAttentionItem({
      ...subject,
      conversationId: null,
      title: 'Ruslan Prakapovich — sent the full proposal, wants an answer',
      priority: 'critical',
      nextAction: 'Decide the group rate',
      fingerprintParts: ['sensitive', '2026-10-04', 'full proposal, 15% commission'],
    })

    delta = await mod.loadAttentionDelta({ workspaceId: WS })
    expect(delta.changed.map((i) => i.subjectId), 'step 10: surfaced again').toContain(CONV)
    expect(delta.unchanged, 'step 9: no longer repetition').toHaveLength(0)
    expect(delta.changed[0].title, 'step 10: with the updated information').toMatch(/full proposal/)
    expect(delta.changed[0].priority).toBe('critical')
    // Still carries what was said last time, so the update reads as a delta.
    expect(delta.changed[0].lastNotifiedSummary).toBe('B2B enquiry — needs your call.')

    // ── 11 + 12. Resolved ────────────────────────────────────────────────
    await mod.setAttentionStatus({ ...subject, status: 'resolved' })

    delta = await mod.loadAttentionDelta({ workspaceId: WS })
    expect(delta.unreported, 'step 12: gone').toHaveLength(0)
    expect(delta.changed, 'step 12: gone').toHaveLength(0)
    expect(delta.unchanged, 'step 12: gone').toHaveLength(0)
    expect(delta.resolvedSince.map((i) => i.subjectId)).toContain(CONV)
    expect(delta.allClear, 'step 12: NOW the owner is genuinely clear').toBe(true)

    // And a resolved item is never described as outstanding.
    const finalContext = mod.renderAttentionContext(delta)
    expect(finalContext).toMatch(/RESOLVED since last time/)
    expect(finalContext).not.toMatch(/The owner is NOT clear/)
  })

  it('acknowledgement is recorded without pretending the item is done', async () => {
    const subject = {
      workspaceId: WS,
      subjectType: mod.SUBJECT_CONVERSATION,
      subjectId: 'conv-ack',
    }
    await mod.observeAttentionItem({
      ...subject,
      conversationId: null,
      title: 'Marissa — refund request',
      priority: 'decision',
      fingerprintParts: ['refund'],
    })
    await mod.markAttentionNotified({ ...subject, summary: 'Refund request — needs your call.' })
    await mod.setAttentionStatus({ ...subject, status: 'acknowledged' })

    const delta = await mod.loadAttentionDelta({ workspaceId: WS })
    // Acknowledged is not resolved: the owner said "seen", not "handled".
    expect(delta.allClear).toBe(false)
    expect(delta.unchanged.map((i) => i.subjectId)).toContain('conv-ack')

    await mod.setAttentionStatus({ ...subject, status: 'resolved' })
  })

  it('records a decision and keeps it queryable', async () => {
    const subject = {
      workspaceId: WS,
      subjectType: mod.SUBJECT_CONVERSATION,
      subjectId: 'conv-decided',
    }
    await mod.observeAttentionItem({
      ...subject,
      conversationId: null,
      title: 'Coral Bay — capacity commitment',
      priority: 'decision',
      fingerprintParts: ['capacity'],
    })
    await mod.setAttentionStatus({ ...subject, status: 'decided', decision: 'Yes at $2,400/mo' })

    const { data } = await supabase
      .from('caye_owner_attention')
      .select('status, decision, decided_at')
      .eq('workspace_id', WS)
      .eq('subject_id', 'conv-decided')
      .single()
    expect(data!.status).toBe('decided')
    expect(data!.decision).toBe('Yes at $2,400/mo')
    expect(data!.decided_at).toBeTruthy()

    await mod.setAttentionStatus({ ...subject, status: 'resolved' })
  })
})

/**
 * MULTIPLE PRODUCERS, ONE ITEM.
 *
 * An escalation, a held conversation and a drafted reply can all describe the
 * same thread. The owner experiences one item and must see one line. Keying
 * the ledger on escalation id (as it briefly did) produced two rows for one
 * thread — a duplicate the unique index cannot catch, because the two rows
 * are genuinely distinct by (subject_type, subject_id).
 */
d('owner attention — one thread, many producers, one row', () => {
  let mod: typeof import('./owner-attention')
  let supabase: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>
  const WS2 = '00000000-dead-4000-a000-000000000003'
  const CONV2 = '11111111-2222-4333-8444-555555555555'

  beforeAll(async () => {
    mod = await import('./owner-attention')
    const { createServiceClient } = await import('@/lib/supabase-server')
    supabase = createServiceClient()
    await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS2)
  })

  afterAll(async () => {
    if (supabase) await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS2)
  })

  it('the escalation path and the hold path land on the same row', async () => {
    // Producer 1: recordEscalation, at composition time (it has the digest).
    await mod.observeAttentionItem({
      workspaceId: WS2,
      subjectType: mod.SUBJECT_CONVERSATION,
      subjectId: CONV2,
      conversationId: CONV2,
      title: 'Ruslan Prakapovich — B2B partnership',
      priority: 'decision',
      nextAction: 'Waiting on your call',
      fingerprintParts: ['sensitive', null, 'group rates'],
    })

    // Producer 2: owner-attention-sync, reconciling from the held queue.
    await mod.observeAttentionItem({
      workspaceId: WS2,
      subjectType: mod.SUBJECT_CONVERSATION,
      subjectId: CONV2,
      conversationId: CONV2,
      title: 'Ruslan Prakapovich — waiting on you',
      priority: 'decision',
      nextAction: 'Draft ready — needs your approval',
      fingerprintParts: ['sensitive', null, 'group rates'],
    })

    const { count } = await supabase
      .from('caye_owner_attention')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', WS2)
      .eq('conversation_id', CONV2)
    expect(count, 'two producers must not create two rows').toBe(1)

    const delta = await mod.loadAttentionDelta({ workspaceId: WS2 })
    const forThread = [...delta.unreported, ...delta.changed, ...delta.unchanged].filter(
      (i) => i.conversationId === CONV2
    )
    expect(forThread, 'the owner sees one item, not two').toHaveLength(1)
    // The later producer's more specific next action wins.
    expect(forThread[0].nextAction).toBe('Draft ready — needs your approval')
  })

  it('notifying once marks the shared row, whichever producer created it', async () => {
    await mod.markAttentionNotified({
      workspaceId: WS2,
      subjectType: mod.SUBJECT_CONVERSATION,
      subjectId: CONV2,
      summary: 'B2B enquiry — needs your call.',
    })
    const delta = await mod.loadAttentionDelta({ workspaceId: WS2 })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.unchanged.map((i) => i.conversationId)).toContain(CONV2)
  })

  it('resolving the conversation clears the one row both producers wrote', async () => {
    await mod.resolveAttentionForConversation(WS2, CONV2)
    const delta = await mod.loadAttentionDelta({ workspaceId: WS2 })
    expect(delta.allClear).toBe(true)
    expect(delta.resolvedSince.map((i) => i.conversationId)).toContain(CONV2)
  })
})
