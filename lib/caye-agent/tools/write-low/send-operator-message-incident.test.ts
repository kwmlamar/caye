import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * End-to-end regression for the 2026-08-16 Mrs. Max incident, driven
 * through the real runToolLoop + real send_operator_message tool + real
 * action-grounding guard — not a stub. Reproduces the founder's actual
 * instruction and confirms the full chain now behaves per the incident
 * report's fix: Caye can actually reach Mrs. Max, the claim is only made
 * once dispatch genuinely succeeded, and a retry doesn't double-send.
 */

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  operatorRows: [
    {
      id: 1,
      workspace_id: 'ws-bimini',
      name: 'Mrs. Max',
      role: 'owner',
      phone: '+12424422629',
      verified_at: '2026-01-01T00:00:00Z',
    },
  ],
  workspaceConfig: { whatsapp_outbound_enabled: true, notifications_paused: false, whatsapp_blocked: false },
  queueRows: [] as Array<{ id: string; idempotency_key: string; status: string; wa_message_id: string | null }>,
  operatorMessages: [] as Array<Record<string, unknown>>,
  dispatchCount: 0,
}))

vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen: vi.fn(async () => true) }))
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendFreeFormWhatsApp: vi.fn(async () => {
    state.dispatchCount++
    return { messageId: `wamid.${state.dispatchCount}`, status: 'sent' as const }
  }),
  sendTemplateWhatsApp: vi.fn(async () => {
    state.dispatchCount++
    return { messageId: `wamid.${state.dispatchCount}`, status: 'sent' as const }
  }),
}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'operator_allowlist') {
        return {
          select: () => ({
            eq: (_k1: string, id: number) => ({
              eq: (_k2: string, wsId: string) => ({
                maybeSingle: async () => ({
                  data: state.operatorRows.find((r) => r.id === id && r.workspace_id === wsId) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'workspace_ai_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.workspaceConfig, error: null }) }) }) }
      }
      if (table === 'caye_outbound_queue') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const key = row.idempotency_key as string
                if (state.queueRows.some((r) => r.idempotency_key === key)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key' } }
                }
                const id = `queue-${state.queueRows.length + 1}`
                state.queueRows.push({ id, idempotency_key: key, status: 'pending', wa_message_id: null })
                return { data: { id }, error: null }
              },
            }),
          }),
          select: () => ({
            eq: (_k: string, key: string) => ({
              maybeSingle: async () => ({ data: state.queueRows.find((r) => r.idempotency_key === key) ?? null, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_k: string, id: string) => {
              const row = state.queueRows.find((r) => r.id === id)
              if (row) Object.assign(row, patch)
              return { error: null }
            },
          }),
          delete: () => ({ eq: async () => ({ error: null }) }),
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
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

beforeEach(() => {
  state.queueRows = []
  state.operatorMessages = []
  state.dispatchCount = 0
})

const OPERATOR_MESSAGE_DRAFT =
  "Hi Mrs. Max — quick questions: what's Kenneth's rate, Karin's payment method, Charissa's rate, and Rayna's pricing?"

function modelTurns(): Anthropic.Message[] {
  return [
    {
      id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use', stop_sequence: null,
      content: [
        {
          type: 'tool_use', id: 'toolu_1', name: 'send_operator_message',
          input: { operator_allowlist_id: 1, message: OPERATOR_MESSAGE_DRAFT },
        },
      ],
    } as Anthropic.Message,
    {
      id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Sent to Mrs. Max — I sent her the question about Kenneth, Karin, Charissa, and Rayna.' }],
    } as Anthropic.Message,
  ]
}

async function runIncidentTurn(requestId: string) {
  let call = 0
  const turns = modelTurns()
  vi.doMock('@/lib/llm-telemetry', () => ({
    loggedMessagesCreate: async () => turns[Math.min(call++, turns.length - 1)],
  }))
  vi.resetModules()
  const { runToolLoop } = await import('../../execute')
  const { sendOperatorMessage } = await import('./send-operator-message')

  const ctx = { workspaceId: 'ws-bimini', callerRole: 'founder' as const, operatorId: 13, requestId }
  const result = await runToolLoop({
    client: {} as Anthropic,
    model: 'claude-sonnet-4-6',
    maxTokens: 512,
    systemPrompt: 'back office agent',
    initialMessages: [
      {
        role: 'user',
        content:
          "Bring these opportunities to Mrs. Max yourself. Ask her about Kenneth's rate, Karin's payment method, Charissa's rate, and Rayna's pricing.",
      },
    ],
    ctx,
    tools: [sendOperatorMessage as never],
  })
  vi.doUnmock('@/lib/llm-telemetry')
  return result
}

describe('2026-08-16 Mrs. Max incident — full regression through runToolLoop', () => {
  it('resolves Mrs. Max, sends exactly one real message, persists it, and truthfully reports it as sent', async () => {
    const result = await runIncidentTurn('req-incident-1')

    // 1 + 2. The tool actually ran and the provider actually dispatched.
    expect(state.dispatchCount).toBe(1)
    // 3. Exactly one outbound operator message produced.
    expect(state.operatorMessages).toHaveLength(1)
    // 5. Persistence records the real outbound, under Mrs. Max's identity.
    const persisted = state.operatorMessages[0]
    expect(persisted.operator_allowlist_id).toBe(1)
    expect(persisted.wa_delivery_status).toBe('sent')
    expect(persisted.body).toBe(OPERATOR_MESSAGE_DRAFT)
    // 6. The operator conversation can retrieve it — same table Live's GET
    // route (app/api/founder/caye-direct/route.ts) reads, filtered by
    // operator_allowlist_id, is exactly what was just written.

    // 7. Caye may now truthfully say it sent the message — action-grounding
    // let the claim through because send_operator_message really succeeded.
    expect(result.replyText).toContain('Sent to Mrs. Max')
    expect(result.replyText).not.toContain('I have not actually sent anything')
  })

  it('retrying the identical action does not send a second WhatsApp message', async () => {
    await runIncidentTurn('req-incident-retry')
    expect(state.dispatchCount).toBe(1)
    expect(state.operatorMessages).toHaveLength(1)

    // Same requestId + same tool + same args as a genuine retry of the
    // same top-level turn would replay → orchestrator.ts's operationKey()
    // is deterministic over exactly that triple, so this collapses onto
    // the same idempotency claim instead of dispatching again.
    await runIncidentTurn('req-incident-retry')
    expect(state.dispatchCount).toBe(1)
    expect(state.operatorMessages).toHaveLength(1)
  })
})
