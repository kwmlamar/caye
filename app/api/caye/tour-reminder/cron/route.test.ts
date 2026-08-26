import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const bookingRow = {
  id: 'booking-1',
  user_id: 'ws-1',
  customer_name: 'Autumn',
  booking_date: '2026-08-26',
  booking_time: '10:00:00',
  conversation_id: 'conv-1',
  service: [{ name: 'Reef Tour', price: 100, price_type: 'per_person' }],
}

let updateEqCalls: Array<{ patch: Record<string, unknown>; id: string }> = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(_table: string) {
      return {
        select() {
          return {
            eq() {
              return this
            },
            is() {
              return this
            },
            limit() {
              return Promise.resolve({ data: [bookingRow], error: null })
            },
          }
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updateEqCalls.push({ patch, id })
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
      }
    },
  }),
}))

const claimConversationExecution = vi.fn()
const validateConversationExecution = vi.fn()
const completeConversationExecution = vi.fn().mockResolvedValue(undefined)
const releaseConversationExecution = vi.fn().mockResolvedValue(undefined)
const resolveConversationExecutionAfterFailure = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/conversation-execution', () => ({
  claimConversationExecution: (...args: unknown[]) => claimConversationExecution(...args),
  validateConversationExecution: (...args: unknown[]) => validateConversationExecution(...args),
  completeConversationExecution: (...args: unknown[]) => completeConversationExecution(...args),
  releaseConversationExecution: (...args: unknown[]) => releaseConversationExecution(...args),
  resolveConversationExecutionAfterFailure: (...args: unknown[]) => resolveConversationExecutionAfterFailure(...args),
}))

const dispatchOperatorReply = vi.fn()
vi.mock('@/lib/whatsapp/channel-dispatch', () => ({
  dispatchOperatorReply: (...args: unknown[]) => dispatchOperatorReply(...args),
}))

const { processBatch } = await import('./route')

function batchArgs(overrides: { onSent: () => void; onSkipped: () => void }) {
  return {
    dateStr: '2026-08-26',
    column: 'day_before_reminder_sent_at' as const,
    framing: 'tomorrow' as const,
    ...overrides,
  }
}

describe('tour-reminder cron processBatch — claim resolution on every terminal branch', () => {
  beforeEach(() => {
    updateEqCalls = []
    claimConversationExecution.mockReset()
    validateConversationExecution.mockReset()
    completeConversationExecution.mockClear()
    releaseConversationExecution.mockClear()
    resolveConversationExecutionAfterFailure.mockClear()
    dispatchOperatorReply.mockReset()
  })

  it('releases the claim when validation fails — does not leak it to the 15-minute lease timeout', async () => {
    claimConversationExecution.mockResolvedValue({ ok: true, claim: { id: 'claim-1', generation: 1 } })
    validateConversationExecution.mockResolvedValue({ ok: false, reason: 'newer_customer_message' })

    let skipped = 0
    let sent = 0
    await processBatch(batchArgs({ onSent: () => sent++, onSkipped: () => skipped++ }))

    expect(releaseConversationExecution).toHaveBeenCalledWith('claim-1')
    expect(dispatchOperatorReply).not.toHaveBeenCalled()
    expect(completeConversationExecution).not.toHaveBeenCalled()
    expect(resolveConversationExecutionAfterFailure).not.toHaveBeenCalled()
    expect(skipped).toBe(1)
    expect(sent).toBe(0)
    expect(updateEqCalls).toHaveLength(0)
  })

  it('resolves (not silently drops) the claim when the provider dispatch itself throws', async () => {
    claimConversationExecution.mockResolvedValue({ ok: true, claim: { id: 'claim-2', generation: 1 } })
    validateConversationExecution.mockResolvedValue({ ok: true })
    dispatchOperatorReply.mockRejectedValue(new Error('WhatsApp API timeout'))

    let skipped = 0
    let sent = 0
    await processBatch(batchArgs({ onSent: () => sent++, onSkipped: () => skipped++ }))

    expect(resolveConversationExecutionAfterFailure).toHaveBeenCalledWith('claim-2', expect.any(Error))
    expect(completeConversationExecution).not.toHaveBeenCalled()
    expect(releaseConversationExecution).not.toHaveBeenCalled()
    expect(skipped).toBe(1)
    expect(sent).toBe(0)
    expect(updateEqCalls).toHaveLength(0)
  })

  it('completes the claim and marks the booking sent on the happy path', async () => {
    claimConversationExecution.mockResolvedValue({ ok: true, claim: { id: 'claim-3', generation: 1 } })
    validateConversationExecution.mockResolvedValue({ ok: true })
    dispatchOperatorReply.mockResolvedValue({ success: true, channelType: 'whatsapp' })

    let skipped = 0
    let sent = 0
    await processBatch(batchArgs({ onSent: () => sent++, onSkipped: () => skipped++ }))

    expect(completeConversationExecution).toHaveBeenCalledWith('claim-3')
    expect(releaseConversationExecution).not.toHaveBeenCalled()
    expect(resolveConversationExecutionAfterFailure).not.toHaveBeenCalled()
    expect(sent).toBe(1)
    expect(skipped).toBe(0)
    expect(updateEqCalls).toEqual([{ patch: { day_before_reminder_sent_at: expect.any(String) }, id: 'booking-1' }])
  })

  it('never leaks a claim when the acquisition itself is blocked — no dispatch, no release needed', async () => {
    claimConversationExecution.mockResolvedValue({ ok: false, blockedBy: 'operator_caye' })

    let skipped = 0
    await processBatch(batchArgs({ onSent: () => undefined, onSkipped: () => skipped++ }))

    expect(validateConversationExecution).not.toHaveBeenCalled()
    expect(dispatchOperatorReply).not.toHaveBeenCalled()
    expect(releaseConversationExecution).not.toHaveBeenCalled()
    expect(skipped).toBe(1)
  })
})
