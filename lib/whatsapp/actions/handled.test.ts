import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const resolveOpenEscalations = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/caye-agent/tools/write-low/resolve-open-escalations', () => ({ resolveOpenEscalations }))

interface State {
  conversation: {
    id: string
    human_agent_enabled: boolean
    human_agent_reason: string | null
    human_agent_marked_at: string | null
  }
  attention: {
    id: string
    state_fingerprint: string
    status: string
    blocked_on_operator: boolean
    completed_at: string | null
    acknowledged_at: string | null
    operator_aware_fingerprint: string | null
  } | null
  outboundRows: Array<{ sent_at: string; metadata: Record<string, unknown> }>
  anomalies: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
}

let state: State

function fakeClient() {
  return {
    from(table: string) {
      if (table === 'unified_conversations') {
        const filters: Record<string, unknown> = {}
        let patch: Record<string, unknown> | null = null
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          update: (value: Record<string, unknown>) => { patch = value; return chain },
          eq: (key: string, value: unknown) => { filters[key] = value; return chain },
          maybeSingle: async () => ({
            data: filters.id === state.conversation.id
              ? { id: state.conversation.id, connected_account: { user_id: 'ws' } }
              : null,
            error: null,
          }),
          then: (resolve: (value: { error: null }) => unknown) => {
            if (patch && filters.id === state.conversation.id) Object.assign(state.conversation, patch)
            return Promise.resolve({ error: null }).then(resolve)
          },
        })
        return chain
      }

      if (table === 'caye_owner_attention') {
        const filters: Record<string, unknown> = {}
        let patch: Record<string, unknown> | null = null
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          update: (value: Record<string, unknown>) => { patch = value; return chain },
          eq: (key: string, value: unknown) => { filters[key] = value; return chain },
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: state.attention, error: null }),
          then: (resolve: (value: { error: null }) => unknown) => {
            if (patch && state.attention && (!filters.id || filters.id === state.attention.id)) {
              Object.assign(state.attention, patch)
            }
            return Promise.resolve({ error: null }).then(resolve)
          },
        })
        return chain
      }

      if (table === 'unified_messages') {
        let cutoff = ''
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          gte: (_key: string, value: string) => { cutoff = value; return chain },
          order: () => chain,
          limit: async () => ({
            data: state.outboundRows.filter((row) => !cutoff || row.sent_at >= cutoff),
            error: null,
          }),
        })
        return chain
      }

      if (table === 'caye_effect_verifications') {
        return {
          upsert: async (value: Record<string, unknown>) => {
            const key = String(value.idempotency_key)
            const existing = state.anomalies.findIndex((row) => row.idempotency_key === key)
            if (existing >= 0) state.anomalies[existing] = value
            else state.anomalies.push(value)
            return { error: null }
          },
        }
      }

      if (table === 'workspace_events') {
        return {
          insert: async (value: Record<string, unknown>) => {
            state.events.push(value)
            return { error: null }
          },
        }
      }

      throw new Error(`unexpected table ${table}`)
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fakeClient() }))

import { actionHandled, hasRecentManualOutboundEvidence } from './handled'

const pending = [{
  index: 1,
  conversationId: 'conv-autumn',
  contactName: 'Autumn McNeill',
  channelType: 'email',
  reason: 'Draft ready — needs your approval',
  proposedReply: 'draft',
  lastMessagePreview: 'Could you provide the instructions?',
  lastMessageAt: '2026-08-30T23:33:32.043Z',
}]

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    conversation: {
      id: 'conv-autumn',
      human_agent_enabled: true,
      human_agent_reason: 'Thread is held for a human — Caye did not reply',
      human_agent_marked_at: '2026-08-26T23:34:08.045Z',
    },
    attention: {
      id: 'attention-autumn',
      state_fingerprint: 'fp-current',
      status: 'open',
      blocked_on_operator: true,
      completed_at: null,
      acknowledged_at: null,
      operator_aware_fingerprint: null,
    },
    outboundRows: [],
    anomalies: [],
    events: [],
  }
})

describe('owner handled is authoritative; transport is separate evidence', () => {
  it('completes the exact attention item immediately even when no outbound has synced', async () => {
    const result = await actionHandled({ workspaceId: 'ws' }, { item_ref: 'Autumn McNeill' }, pending)

    expect(result.tag?.status).toBe('ok')
    expect(result.ackBody).toContain('marked Autumn McNeill as handled')
    expect(result.ackBody).not.toContain('left it open')
    expect(state.conversation.human_agent_enabled).toBe(false)
    expect(state.conversation.human_agent_marked_at).toBeNull()
    expect(state.attention?.status).toBe('resolved')
    expect(state.attention?.blocked_on_operator).toBe(false)
    expect(state.attention?.completed_at).toBeTruthy()
    expect(state.attention?.acknowledged_at).toBeTruthy()
    expect(state.attention?.operator_aware_fingerprint).toBe('fp-current')

    expect(state.anomalies).toHaveLength(1)
    expect(state.anomalies[0]).toMatchObject({
      effect: 'customer_reply_delivery_sync',
      ambiguity_reason: 'delivery_sync_anomaly',
      verification_status: 'INDETERMINATE',
      recovery_state: 'observe_only',
      authority_ref: 'attention:attention-autumn',
    })
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      type: 'attention.completed_by_operator',
      actor_kind: 'operator',
      subject_id: 'attention-autumn',
      conversation_id: 'conv-autumn',
    })
  })

  it('does not create a sync anomaly when manual outbound evidence is already present', async () => {
    state.outboundRows = [{
      sent_at: new Date().toISOString(),
      metadata: { source: 'zoho_sent', sent_by: 'human' },
    }]

    const result = await actionHandled({ workspaceId: 'ws' }, { item_ref: 'Autumn McNeill' }, pending)

    expect(result.tag?.status).toBe('ok')
    expect(state.attention?.status).toBe('resolved')
    expect(state.anomalies).toHaveLength(0)
  })

  it('is idempotent under a repeated handled acknowledgement: no duplicate anomaly identity', async () => {
    await actionHandled({ workspaceId: 'ws' }, { item_ref: 'Autumn McNeill' }, pending)
    // Simulate a stale pending snapshot arriving again before the UI refreshes.
    state.attention!.status = 'open'
    await actionHandled({ workspaceId: 'ws' }, { item_ref: 'Autumn McNeill' }, pending)

    expect(state.conversation.human_agent_enabled).toBe(false)
    expect(state.attention?.status).toBe('resolved')
    expect(state.anomalies).toHaveLength(1)
    expect(state.anomalies[0].idempotency_key).toBe('manual-reply-sync:attention-autumn')
  })
})

describe('manual outbound evidence', () => {
  it('returns false when the unified mirror has no outbound yet', async () => {
    expect(await hasRecentManualOutboundEvidence(fakeClient() as never, 'conv-autumn')).toBe(false)
  })

  it('accepts operator-approved outbound as evidence', async () => {
    state.outboundRows = [{ sent_at: new Date().toISOString(), metadata: { operator_approved: true } }]
    expect(await hasRecentManualOutboundEvidence(fakeClient() as never, 'conv-autumn')).toBe(true)
  })
})
