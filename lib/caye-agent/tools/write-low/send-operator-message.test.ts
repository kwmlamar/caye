import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  operatorRows: [] as Array<{
    id: number
    workspace_id: string
    name: string | null
    role: string
    phone: string
    verified_at: string | null
  }>,
  workspaceConfig: {
    whatsapp_outbound_enabled: true,
    notifications_paused: false,
    whatsapp_blocked: false,
  } as { whatsapp_outbound_enabled: boolean; notifications_paused: boolean; whatsapp_blocked: boolean } | null,
  queueRows: [] as Array<{
    id: string
    idempotency_key: string
    status: string
    wa_message_id: string | null
    last_error: string | null
  }>,
  operatorMessages: [] as Array<Record<string, unknown>>,
  windowOpen: true,
  sendResult: { messageId: 'wamid.test1', status: 'sent' as const } as
    | { messageId: string; status: 'sent' }
    | { status: 'failed'; error: string; transient: boolean; blocked?: boolean },
  insertQueueCallCount: 0,
}))

function reset() {
  state.operatorRows = [
    {
      id: 1,
      workspace_id: 'ws-bimini',
      name: 'Mrs. Max',
      role: 'owner',
      phone: '+12424422629',
      verified_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 22,
      workspace_id: 'ws-bimini',
      name: 'Max',
      role: 'owner',
      phone: '+12424730233',
      verified_at: null, // unverified
    },
    {
      id: 5,
      workspace_id: 'ws-bimini',
      name: 'Trevor',
      role: 'driver',
      phone: '+12420000000',
      verified_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 13,
      workspace_id: 'ws-bimini',
      name: 'Lamar',
      role: 'founder',
      phone: '+13342219466',
      verified_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 99,
      workspace_id: 'ws-OTHER-workspace',
      name: 'Someone Else',
      role: 'owner',
      phone: '+19995551234',
      verified_at: '2026-01-01T00:00:00Z',
    },
  ]
  state.workspaceConfig = { whatsapp_outbound_enabled: true, notifications_paused: false, whatsapp_blocked: false }
  state.queueRows = []
  state.operatorMessages = []
  state.windowOpen = true
  state.sendResult = { messageId: 'wamid.test1', status: 'sent' }
  state.insertQueueCallCount = 0
}

vi.mock('@/lib/whatsapp/window', () => ({
  isWhatsAppWindowOpen: vi.fn(async () => state.windowOpen),
}))
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendFreeFormWhatsApp: vi.fn(async () => state.sendResult),
  sendTemplateWhatsApp: vi.fn(async () => state.sendResult),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'operator_allowlist') {
        return {
          select: () => ({
            eq: (_k1: string, id: number) => ({
              eq: (_k2: string, workspaceId: string) => ({
                maybeSingle: async () => ({
                  data: state.operatorRows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'workspace_ai_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.workspaceConfig, error: null }),
            }),
          }),
        }
      }
      if (table === 'caye_outbound_queue') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                state.insertQueueCallCount++
                const key = row.idempotency_key as string
                if (state.queueRows.some((r) => r.idempotency_key === key)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key' } }
                }
                const id = `queue-${state.queueRows.length + 1}`
                state.queueRows.push({ id, idempotency_key: key, status: 'pending', wa_message_id: null, last_error: null })
                return { data: { id }, error: null }
              },
            }),
          }),
          select: () => ({
            eq: (_k: string, key: string) => ({
              maybeSingle: async () => ({
                data: state.queueRows.find((r) => r.idempotency_key === key) ?? null,
                error: null,
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_k: string, id: string) => {
              const row = state.queueRows.find((r) => r.id === id)
              if (row) Object.assign(row, patch)
              return { error: null }
            },
          }),
          delete: () => ({
            eq: async (_k: string, id: string) => {
              state.queueRows = state.queueRows.filter((r) => r.id !== id)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'caye_operator_messages') {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.operatorMessages.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }),
}))

import { sendOperatorMessage } from './send-operator-message'

const baseCtx: ToolContext = {
  workspaceId: 'ws-bimini',
  callerRole: 'founder',
  operatorId: 13, // Lamar, the caller
  requestId: 'req-1',
  operationKey: 'req-1:send_operator_message:abc123',
}

beforeEach(() => {
  reset()
})

describe('send_operator_message — authorization boundaries', () => {
  it('rejects a nonexistent operator id', async () => {
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 404, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NOT_FOUND')
    expect(state.operatorMessages).toHaveLength(0)
  })

  it('rejects an operator belonging to a different workspace — cross-workspace send is structurally impossible', async () => {
    // id 99 is real, but only in ws-OTHER-workspace, not ws-bimini.
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 99, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NOT_FOUND')
    expect(state.operatorMessages).toHaveLength(0)
  })

  it('rejects an unverified operator', async () => {
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 22, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(state.operatorMessages).toHaveLength(0)
  })

  it('rejects a driver-role target (use notify_driver instead)', async () => {
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 5, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/notify_driver/)
  })

  it('rejects messaging yourself', async () => {
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 13, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
  })

  it('has no input field that accepts an arbitrary phone number — only a workspace-scoped id', () => {
    const props = Object.keys(sendOperatorMessage.inputSchema.properties ?? {})
    expect(props).toEqual(['operator_allowlist_id', 'message'])
    expect(props.some((p) => /phone|number|recipient/i.test(p))).toBe(false)
  })

  it('only owner/founder may initiate a proactive send — staff removed (2026-08-16 hardening)', () => {
    // Role gating itself runs in execute.ts's tool loop (`tool.roles.includes
    // (ctx.callerRole)`), before execute() is ever called — so the contract
    // this tool must uphold is its declared roles list, not a self-check.
    expect(sendOperatorMessage.roles).toEqual(['owner', 'founder'])
    expect(sendOperatorMessage.roles).not.toContain('staff')
  })
})

describe('send_operator_message — delivery channel preconditions', () => {
  it('reports no eligible channel when WhatsApp outbound is not enabled for the workspace', async () => {
    state.workspaceConfig!.whatsapp_outbound_enabled = false
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/channel/i)
  })

  it('refuses to send while notifications are paused', async () => {
    state.workspaceConfig!.notifications_paused = true
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
  })
})

describe('send_operator_message — real dispatch semantics', () => {
  it('succeeds only after a real provider dispatch, and persists into caye_operator_messages under the TARGET operator', async () => {
    const result = await sendOperatorMessage.execute(
      { operator_allowlist_id: 1, message: 'Quick question about Kenneth Cal.' },
      baseCtx
    )
    expect(result.ok).toBe(true)
    expect((result.data as { sent: boolean }).sent).toBe(true)
    expect((result.data as { message_id: string }).message_id).toBe('wamid.test1')

    expect(state.operatorMessages).toHaveLength(1)
    const persisted = state.operatorMessages[0]
    expect(persisted.operator_allowlist_id).toBe(1) // Mrs. Max, not the caller (13)
    expect(persisted.direction).toBe('outbound')
    expect(persisted.wa_message_id).toBe('wamid.test1')
    expect(persisted.wa_delivery_status).toBe('sent')
    expect(persisted.body).toBe('Quick question about Kenneth Cal.')

    const row = state.queueRows[0]
    expect(row.status).toBe('sent')
  })

  it('uses the free-form path when the recipient window is open, template when closed', async () => {
    state.windowOpen = false
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(true)
    expect((result.data as { delivered_via: string }).delivered_via).toBe('template')
  })

  it('reports failure (not success) when the provider rejects the message', async () => {
    state.sendResult = { status: 'failed', error: 'meta rejected', transient: false }
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(state.operatorMessages).toHaveLength(0)
    expect(state.queueRows[0].status).toBe('failed')
  })

  it('releases the idempotency claim on a transient failure so a retry can actually attempt the send', async () => {
    state.sendResult = { status: 'failed', error: 'network blip', transient: true }
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('FAILED_RETRYABLE')
    // The claim row was deleted, not left around — a same-key retry gets a
    // fresh dispatch attempt instead of a cached failure.
    expect(state.queueRows).toHaveLength(0)
  })

  it('reports a blocked recipient as needing a human, never as sent', async () => {
    state.sendResult = { status: 'failed', error: 'recipient blocked', transient: false, blocked: true }
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
  })
})

describe('send_operator_message — never silently truncates (2026-08-16 hardening)', () => {
  const SHORT_MESSAGE = 'Quick question about Kenneth Cal.'
  // Deliberately > 180 chars (the caye_urgent_hold template's practical
  // safe length) so it cannot fit the template placeholder without cutting
  // real content.
  const LONG_MESSAGE =
    "Hi Mrs. Max — I've been looking at some recent inquiries and there's money sitting on the table I'd love to help close. Kenneth Cal asked about a private Full Bimini Experience for 8 guests on Aug 26 — what rate should I quote him?"

  it('short message, open window — sent free-form, full text, no dispatch refused', async () => {
    state.windowOpen = true
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: SHORT_MESSAGE }, baseCtx)
    expect(result.ok).toBe(true)
    expect((result.data as { delivered_via: string }).delivered_via).toBe('free_form')
    expect(state.operatorMessages[0].body).toBe(SHORT_MESSAGE)
  })

  it('long message, open window — sent free-form, full text, never truncated (free-form has no length gate)', async () => {
    state.windowOpen = true
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: LONG_MESSAGE }, baseCtx)
    expect(result.ok).toBe(true)
    expect((result.data as { delivered_via: string }).delivered_via).toBe('free_form')
    expect(state.operatorMessages[0].body).toBe(LONG_MESSAGE)
    expect(state.operatorMessages[0].body).not.toContain('…')
  })

  it('short message, closed window — delivered whole via the approved template, not cut', async () => {
    state.windowOpen = false
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: SHORT_MESSAGE }, baseCtx)
    expect(result.ok).toBe(true)
    expect((result.data as { delivered_via: string }).delivered_via).toBe('template')
    expect(state.operatorMessages[0].body).toBe(SHORT_MESSAGE)
    expect(state.operatorMessages[0].body).not.toContain('…')
  })

  it('long message, closed window — refuses to send rather than silently deliver a cut-down version', async () => {
    state.windowOpen = false
    const result = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: LONG_MESSAGE }, baseCtx)

    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error).toMatch(/too long/i)
    expect(result.error).toMatch(/window/i)

    // Nothing was sent, nothing persisted, and the claim was released — a
    // shortened retry or the operator reopening the window can try again.
    expect(state.operatorMessages).toHaveLength(0)
    expect(state.queueRows).toHaveLength(0)
  })
})

describe('send_operator_message — idempotency', () => {
  it('a retry with the same operationKey does not dispatch twice, and reports the cached success', async () => {
    const first = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(first.ok).toBe(true)
    expect(state.operatorMessages).toHaveLength(1)

    const second = await sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'hi' }, baseCtx)
    expect(second.ok).toBe(true)
    expect((second.data as { idempotent_replay?: boolean }).idempotent_replay).toBe(true)
    // Still exactly one real persisted send — the retry didn't dispatch again.
    expect(state.operatorMessages).toHaveLength(1)
  })

  it('a genuinely concurrent duplicate insert (both calls race the claim) still results in one logical message', async () => {
    const [a, b] = await Promise.all([
      sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'race' }, baseCtx),
      sendOperatorMessage.execute({ operator_allowlist_id: 1, message: 'race' }, baseCtx),
    ])
    const oks = [a, b].filter((r) => r.ok)
    expect(state.operatorMessages.length).toBeLessThanOrEqual(1)
    expect(oks.length).toBeGreaterThanOrEqual(1)
  })
})
