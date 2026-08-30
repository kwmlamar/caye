import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const {
  observeAttentionItem,
  markAttentionNotified,
  recordOperatorAwareness,
  setAttentionStatus,
  hasOperatorParticipatedInConversation,
} = vi.hoisted(() => ({
  observeAttentionItem: vi.fn(),
  markAttentionNotified: vi.fn(),
  recordOperatorAwareness: vi.fn(),
  setAttentionStatus: vi.fn(),
  hasOperatorParticipatedInConversation: vi.fn(),
}))

vi.mock('@/lib/owner-attention', () => ({
  observeAttentionItem,
  markAttentionNotified,
  recordOperatorAwareness,
  setAttentionStatus,
}))

vi.mock('./operator-participation', () => ({
  hasOperatorParticipatedInConversation,
}))

let outboundMessages: Array<Record<string, unknown>> = []
let proactiveQueueRows: Array<Record<string, unknown>> = []
let policyAuditUpdates: Array<Record<string, unknown>> = []

function chainForRows(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self,
    eq: self,
    gte: self,
    in: self,
    limit: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
  })
  return chain
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'caye_operator_messages') {
        return chainForRows(outboundMessages)
      }
      if (table === 'caye_outbound_queue') {
        return chainForRows(proactiveQueueRows)
      }
      if (table === 'caye_owner_attention') {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          update(patch: Record<string, unknown>) {
            policyAuditUpdates.push(patch)
            return { eq: () => Promise.resolve({ data: null, error: null }) }
          },
        })
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { decideOperatorNotification } from './operator-notification-gate'

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'attn-1',
    workspaceId: 'ws-a',
    subjectType: 'booking',
    subjectId: 'booking-1',
    conversationId: null,
    title: 'Booking',
    priority: 'awareness',
    status: 'open',
    firstNotifiedAt: null,
    lastNotifiedAt: null,
    notifyCount: 0,
    lastNotifiedSummary: null,
    acknowledgedAt: null,
    decidedAt: null,
    decision: null,
    nextAction: null,
    completedAt: null,
    stateFingerprint: 'fp-current',
    notifiedFingerprint: null,
    lastChangedAt: '2026-08-30T12:00:00Z',
    digest: null,
    blockedOnOperator: false,
    resolvableAutonomously: false,
    lastNotificationQueueId: null,
    pendingNotificationQueueId: null,
    operatorAwareFingerprint: null,
    operatorAwareAt: null,
    operatorAwareSummary: null,
    firstStateFingerprint: 'fp-current',
    ...over,
  }
}

const baseInput = {
  workspaceId: 'ws-a',
  subjectType: 'booking',
  subjectId: 'booking-1',
  title: 'Booking',
  priority: 'awareness' as const,
  fingerprintParts: ['pending', '2026-09-01'],
  blockedOnOperator: false,
  resolvableAutonomously: false,
}

beforeEach(() => {
  outboundMessages = []
  proactiveQueueRows = []
  policyAuditUpdates = []
  observeAttentionItem.mockReset()
  observeAttentionItem.mockResolvedValue(item())
  markAttentionNotified.mockReset()
  recordOperatorAwareness.mockReset()
  setAttentionStatus.mockReset()
  hasOperatorParticipatedInConversation.mockReset()
})

describe('operator notification policy integration', () => {
  it('keeps a low-confidence ordinary observation quiet and auditable', async () => {
    const decision = await decideOperatorNotification({
      ...baseInput,
      confidence: 'low',
      consequencesOfWaiting: 'low',
    })

    expect(decision.outcome).toBe('SUPPRESS_NO_CHANGE')
    expect(decision.interruptionPolicy?.action).toBe('WATCH')
    expect(decision.interruptionPolicy?.reasonCodes).toContain('avoid_unverified_claim')
    expect(policyAuditUpdates.at(-1)?.last_policy_decision).toMatchObject({
      action: 'WATCH',
      dimensions: expect.objectContaining({ confidence: 'low' }),
    })
  })

  it('accepts urgency and importance independently of legacy attention priority', async () => {
    const decision = await decideOperatorNotification({
      ...baseInput,
      priority: 'routine',
      urgency: 'high',
      importance: 'critical',
    })

    expect(decision.interruptionPolicy?.action).toBe('SURFACE_NOW')
    expect(policyAuditUpdates.at(-1)?.last_policy_decision).toMatchObject({
      dimensions: expect.objectContaining({ urgency: 'high', importance: 'critical' }),
    })
  })

  it('does not spend interruption budget on ordinary dashboard conversation turns', async () => {
    outboundMessages = Array.from({ length: 100 }, (_, i) => ({ id: `chat-${i}` }))

    // Dashboard turns still participate in the legacy 15-minute cooldown. This
    // test isolates the NEW 24-hour proactive budget from that existing guard.
    const decision = await decideOperatorNotification({ ...baseInput, bypassCooldown: true })

    expect(decision.outcome).toBe('SEND_NEW')
    expect(decision.interruptionPolicy?.reasonCodes).not.toContain('interruption_budget_exhausted')
  })

  it('defers ordinary awareness traffic after three proactive queue sends in 24h', async () => {
    proactiveQueueRows = [{ id: '1' }, { id: '2' }, { id: '3' }]

    const decision = await decideOperatorNotification(baseInput)

    expect(decision.outcome).toBe('SUPPRESS_RECENTLY_NOTIFIED')
    expect(decision.interruptionPolicy?.action).toBe('WATCH')
    expect(decision.interruptionPolicy?.reasonCodes).toContain('interruption_budget_exhausted')
  })

  it('lets an explicit worsening bypass ordinary low-priority cooldown', async () => {
    outboundMessages = [{ id: 'recent' }]
    observeAttentionItem.mockResolvedValue(item({
      notifyCount: 1,
      lastNotifiedAt: '2026-08-30T11:50:00Z',
      notifiedFingerprint: 'fp-old',
    }))

    const decision = await decideOperatorNotification({
      ...baseInput,
      materialChangeKind: 'worsened',
    })

    expect(decision.outcome).toBe('SEND_NEW')
    expect(decision.isMaterialChange).toBe(true)
    expect(decision.interruptionPolicy?.action).toBe('SURFACE_NOW')
    expect(decision.interruptionPolicy?.bypassCooldown).toBe(true)
  })

  it('does not confuse autonomous capability with authority', async () => {
    const decision = await decideOperatorNotification({
      ...baseInput,
      resolvableAutonomously: true,
      authorityAllowsAutonomousAction: false,
    })

    expect(decision.outcome).toBe('SEND_NEW')
    expect(decision.interruptionPolicy?.reasonCodes).toContain('authority_blocks_action')
    expect(setAttentionStatus).not.toHaveBeenCalled()
  })

  it('silently resolves when the existing authority result allows autonomous handling', async () => {
    const decision = await decideOperatorNotification({
      ...baseInput,
      resolvableAutonomously: true,
      authorityAllowsAutonomousAction: true,
    })

    expect(decision.outcome).toBe('RESOLVED_NO_NOTIFICATION')
    expect(decision.interruptionPolicy?.action).toBe('HANDLE_AUTONOMOUSLY')
    expect(setAttentionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'resolved' }))
  })

  it('replays one issue from new to duplicate to worsening to resolved without external side effects', async () => {
    observeAttentionItem
      .mockResolvedValueOnce(item())
      .mockResolvedValueOnce(item({
        notifyCount: 1,
        lastNotifiedAt: '2026-08-30T12:05:00Z',
        stateFingerprint: 'fp-current',
        notifiedFingerprint: 'fp-current',
      }))
      .mockResolvedValueOnce(item({
        notifyCount: 1,
        lastNotifiedAt: '2026-08-30T12:05:00Z',
        stateFingerprint: 'fp-worse',
        notifiedFingerprint: 'fp-current',
      }))
      .mockResolvedValueOnce(item({
        status: 'resolved',
        notifyCount: 2,
        lastNotifiedAt: '2026-08-30T12:20:00Z',
        stateFingerprint: 'fp-worse',
        notifiedFingerprint: 'fp-worse',
      }))

    const first = await decideOperatorNotification(baseInput)
    const duplicate = await decideOperatorNotification(baseInput)
    const worsened = await decideOperatorNotification({ ...baseInput, materialChangeKind: 'worsened' })
    const resolved = await decideOperatorNotification(baseInput)

    expect(first.outcome).toBe('SEND_NEW')
    expect(duplicate.outcome).toBe('SUPPRESS_NO_CHANGE')
    expect(worsened.outcome).toBe('SEND_NEW')
    expect(worsened.isMaterialChange).toBe(true)
    expect(resolved.outcome).toBe('RESOLVED_NO_NOTIFICATION')
    expect(resolved.interruptionPolicy?.action).toBe('RESOLVE_SILENTLY')
  })
})
