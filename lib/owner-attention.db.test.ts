import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * DATABASE-BACKED verification of the attention ledger.
 *
 * The unit tests in owner-attention.test.ts assert the bucketing logic against
 * a fake client. They cannot catch a column that does not exist, a CHECK
 * constraint that rejects a value the code emits, or a unique index that does
 * not dedupe the way the code assumes — and the whole point of this ledger is
 * that `allClear` stops silently lying, which a missing table would restore.
 *
 * OPT-IN. Runs only with RUN_DB_TESTS=1, because it writes to the real
 * project. Everything it writes is namespaced to a synthetic workspace uuid
 * and deleted in afterAll, so it never touches a customer's rows.
 *
 *   RUN_DB_TESTS=1 npx vitest run lib/owner-attention.db.test.ts
 */

const ENABLED = process.env.RUN_DB_TESTS === '1'
const d = ENABLED ? describe : describe.skip

// Fixed so a crashed run's rows are still findable and cleanable by hand.
const WS = '00000000-dead-4000-a000-0000000000at'.replace('at', '01')

d('caye_owner_attention — against the real database', () => {
  let observeAttentionItem: typeof import('./owner-attention').observeAttentionItem
  let markAttentionNotified: typeof import('./owner-attention').markAttentionNotified
  let loadAttentionDelta: typeof import('./owner-attention').loadAttentionDelta
  let setAttentionStatus: typeof import('./owner-attention').setAttentionStatus
  let fingerprint: typeof import('./owner-attention').fingerprint
  let SUBJECT_CONVERSATION: string
  let supabase: ReturnType<typeof import('@/lib/supabase-server').createServiceClient>

  beforeAll(async () => {
    const mod = await import('./owner-attention')
    observeAttentionItem = mod.observeAttentionItem
    markAttentionNotified = mod.markAttentionNotified
    loadAttentionDelta = mod.loadAttentionDelta
    setAttentionStatus = mod.setAttentionStatus
    fingerprint = mod.fingerprint
    SUBJECT_CONVERSATION = mod.SUBJECT_CONVERSATION
    const { createServiceClient } = await import('@/lib/supabase-server')
    supabase = createServiceClient()
    await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS)
  })

  afterAll(async () => {
    if (supabase) await supabase.from('caye_owner_attention').delete().eq('workspace_id', WS)
  })

  it('the table exists and reads return a real empty state, not a degraded one', async () => {
    // The degradation this guards: before the migration, every read threw and
    // loadAttentionDelta caught it and returned allClear: true — meaning "the
    // owner is clear" was indistinguishable from "the table is missing".
    const { error } = await supabase.from('caye_owner_attention').select('id').limit(1)
    expect(error).toBeNull()

    const delta = await loadAttentionDelta({ workspaceId: WS })
    expect(delta.allClear).toBe(true)
    expect(delta.unreported).toHaveLength(0)
  })

  it('writes persist, including the fingerprint', async () => {
    const item = await observeAttentionItem({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-1',
      title: 'Ruslan Prakapovich — B2B partnership',
      priority: 'decision',
      nextAction: 'Waiting on your call',
      fingerprintParts: ['sensitive', null, 'group rate'],
    })
    expect(item).not.toBeNull()
    expect(item!.stateFingerprint).toBe(fingerprint(['sensitive', null, 'group rate']))

    const { data } = await supabase
      .from('caye_owner_attention')
      .select('title, priority, status, state_fingerprint')
      .eq('workspace_id', WS)
      .eq('subject_id', 'conv-db-1')
      .single()
    expect(data!.priority).toBe('decision')
    expect(data!.status).toBe('open')
    expect(data!.state_fingerprint).toBeTruthy()
  })

  it('a fresh item reads back as unreported and blocks allClear', async () => {
    const delta = await loadAttentionDelta({ workspaceId: WS })
    expect(delta.allClear).toBe(false)
    expect(delta.unreported.map((i) => i.subjectId)).toContain('conv-db-1')
  })

  it('the unique index dedupes — a second observe updates, never inserts', async () => {
    await observeAttentionItem({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-1',
      title: 'Ruslan Prakapovich — B2B partnership (seen again)',
      priority: 'decision',
      fingerprintParts: ['sensitive', null, 'group rate'],
    })
    const { count } = await supabase
      .from('caye_owner_attention')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', WS)
      .eq('subject_id', 'conv-db-1')
    expect(count).toBe(1)
  })

  it('notification state persists and stamps the fingerprint', async () => {
    await markAttentionNotified({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-1',
      summary: 'B2B enquiry — needs your call.',
    })
    const { data } = await supabase
      .from('caye_owner_attention')
      .select('first_notified_at, last_notified_at, notify_count, last_notified_summary, notified_fingerprint, state_fingerprint')
      .eq('workspace_id', WS)
      .eq('subject_id', 'conv-db-1')
      .single()

    expect(data!.first_notified_at).toBeTruthy()
    expect(data!.notify_count).toBe(1)
    expect(data!.last_notified_summary).toBe('B2B enquiry — needs your call.')
    // The stamp is what separates news from repetition on the next read.
    expect(data!.notified_fingerprint).toBe(data!.state_fingerprint)
  })

  it('an already-told, unchanged item is repetition, not news', async () => {
    const delta = await loadAttentionDelta({ workspaceId: WS })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged.map((i) => i.subjectId)).toContain('conv-db-1')
    // Still open, so the owner is still not clear.
    expect(delta.allClear).toBe(false)
  })

  it('a real state change moves it back into news', async () => {
    await observeAttentionItem({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-1',
      title: 'Ruslan Prakapovich — followed up with a new ask',
      priority: 'decision',
      fingerprintParts: ['sensitive', '2026-10-04', 'group rate for 12+'],
    })
    const delta = await loadAttentionDelta({ workspaceId: WS })
    expect(delta.changed.map((i) => i.subjectId)).toContain('conv-db-1')
    expect(delta.unchanged).toHaveLength(0)
    // And the composer can see what it said last time, to give a delta.
    expect(delta.changed[0].lastNotifiedSummary).toBe('B2B enquiry — needs your call.')
  })

  it('resolution removes it from outstanding attention', async () => {
    await setAttentionStatus({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-1',
      status: 'resolved',
    })
    const delta = await loadAttentionDelta({ workspaceId: WS })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged).toHaveLength(0)
    expect(delta.resolvedSince.map((i) => i.subjectId)).toContain('conv-db-1')
    expect(delta.allClear).toBe(true)
  })

  it('every priority and status the code can emit satisfies the CHECK constraints', async () => {
    // The constraint values are in the migration; the code's unions are in
    // TypeScript. Nothing enforces that they agree, so assert it against the
    // real table rather than by eye.
    for (const priority of ['critical', 'decision', 'awareness', 'routine'] as const) {
      const item = await observeAttentionItem({
        workspaceId: WS,
        subjectType: SUBJECT_CONVERSATION,
        subjectId: `conv-prio-${priority}`,
        title: `priority ${priority}`,
        priority,
        fingerprintParts: [priority],
      })
      expect(item, priority).not.toBeNull()
    }
    for (const status of ['open', 'acknowledged', 'decided', 'resolved', 'dismissed'] as const) {
      await setAttentionStatus({
        workspaceId: WS,
        subjectType: SUBJECT_CONVERSATION,
        subjectId: 'conv-prio-routine',
        status,
      })
      const { data } = await supabase
        .from('caye_owner_attention')
        .select('status')
        .eq('workspace_id', WS)
        .eq('subject_id', 'conv-prio-routine')
        .single()
      expect(data!.status, status).toBe(status)
    }
  })

  it('stores and reads back the digest jsonb', async () => {
    await observeAttentionItem({
      workspaceId: WS,
      subjectType: SUBJECT_CONVERSATION,
      subjectId: 'conv-db-digest',
      title: 'digest carrier',
      priority: 'decision',
      fingerprintParts: ['x'],
      digest: {
        sender: 'Ruslan Prakapovich',
        organization: 'Accessible Travel Solutions',
        intent: 'wants recurring group bookings',
        whyItMatters: null,
        currentStatus: null,
        requestedAction: null,
        deadline: null,
        financialImpact: null,
        commitmentsMade: null,
        recommendedAction: null,
        decisionNeeded: null,
        confidence: 'high',
        substantive: true,
        actionNeeded: true,
      },
    })
    const delta = await loadAttentionDelta({ workspaceId: WS })
    const item = delta.unreported.find((i) => i.subjectId === 'conv-db-digest')
    // Kept so the owner can ask for detail without Caye re-reading the email.
    expect(item?.digest?.sender).toBe('Ruslan Prakapovich')
    expect(item?.digest?.intent).toBe('wants recurring group bookings')
  })
})
