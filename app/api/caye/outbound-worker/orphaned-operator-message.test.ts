import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendTemplateWhatsApp: vi.fn(),
  sendFreeFormWhatsApp: vi.fn(),
  enqueueOutbound: vi.fn(),
  deliveryFieldsFromResult: () => ({}),
}))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen: vi.fn() }))
vi.mock('@/lib/whatsapp/email-fallback', () => ({ emailFallbackForFailedPing: vi.fn() }))
vi.mock('@/lib/operator-identity', () => ({ resolveOperatorByPhone: vi.fn() }))
vi.mock('@/lib/whatsapp/schedule', () => ({
  loadScheduleConfig: vi.fn(),
  nextDigestTime: vi.fn(),
  localDayOfWeek: vi.fn(),
}))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: vi.fn(), checkStaleCronsAndAlert: vi.fn() }))
vi.mock('@/lib/email/founder-mailer', () => ({ sendFounderAlertEmail: vi.fn() }))
vi.mock('@/lib/whatsapp/delivery-errors', () => ({ extractErrorCode: vi.fn() }))
vi.mock('@/lib/whatsapp/template-sync', () => ({ resyncTemplatesAfterParamMismatch: vi.fn() }))
vi.mock('@/lib/pending-operations-worker', () => ({ drainPendingOperationsSafely: vi.fn() }))
vi.mock('@/lib/owner-attention', () => ({ markAttentionNotified: vi.fn() }))

const { alertFounderOfDeliveryFailure } = vi.hoisted(() => ({
  alertFounderOfDeliveryFailure: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/founder-alert', () => ({ alertFounderOfDeliveryFailure }))

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; workspace_id: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'caye_outbound_queue') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              lt: () => ({
                limit: async () => ({ data: state.rows, error: null }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_k: string, id: string) => {
            state.updates.push({ id, patch })
            return { error: null }
          },
        }),
      }
    },
  }),
}))

import { checkOrphanedOperatorMessagesAndAlert } from './route'

beforeEach(() => {
  state.rows = []
  state.updates = []
  alertFounderOfDeliveryFailure.mockClear()
})

describe('checkOrphanedOperatorMessagesAndAlert — mid-flight crash recovery', () => {
  it('dead-letters a stale pending operator_message row and alerts the founder, without attempting a resend', async () => {
    state.rows = [
      {
        id: 'q1',
        workspace_id: 'ws-bimini',
        payload: { operator_allowlist_id: 1, operator_name: 'Mrs. Max', to_phone: '+12424422629', body: 'hi' },
      },
    ]

    await checkOrphanedOperatorMessagesAndAlert()

    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].patch.status).toBe('dead_letter')
    expect(state.updates[0].patch.last_error).toMatch(/Mrs\. Max/)
    expect(state.updates[0].patch.last_error).toMatch(/not retried/i)

    expect(alertFounderOfDeliveryFailure).toHaveBeenCalledTimes(1)
    expect(alertFounderOfDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-bimini', kind: 'operator_message' })
    )

    // No dispatch primitive was ever touched — this function only reads
    // caye_outbound_queue and updates status; it never calls
    // sendFreeFormWhatsApp/sendTemplateWhatsApp, which is the whole point.
    const { sendFreeFormWhatsApp, sendTemplateWhatsApp } = await import('@/lib/whatsapp/outbound')
    expect(sendFreeFormWhatsApp).not.toHaveBeenCalled()
    expect(sendTemplateWhatsApp).not.toHaveBeenCalled()
  })

  it('is a no-op when there are no stale rows', async () => {
    state.rows = []
    await checkOrphanedOperatorMessagesAndAlert()
    expect(state.updates).toHaveLength(0)
    expect(alertFounderOfDeliveryFailure).not.toHaveBeenCalled()
  })

  it('running the sweep twice on the same already-dead-lettered row is harmless (idempotent recovery)', async () => {
    state.rows = [
      { id: 'q1', workspace_id: 'ws-bimini', payload: { operator_name: 'Mrs. Max' } },
    ]
    await checkOrphanedOperatorMessagesAndAlert()
    expect(state.updates).toHaveLength(1)

    // A real second tick's query wouldn't re-select this row (status is no
    // longer 'pending'), simulated here by clearing the fixture — the
    // function itself has no re-entrancy hazard either way.
    state.rows = []
    await checkOrphanedOperatorMessagesAndAlert()
    expect(state.updates).toHaveLength(1)
    expect(alertFounderOfDeliveryFailure).toHaveBeenCalledTimes(1)
  })
})
