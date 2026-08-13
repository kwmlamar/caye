import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const { enqueueEscalationPings, decideOperatorNotification, recordOperatorNotified, gateState } = vi.hoisted(() => ({
  enqueueEscalationPings: vi.fn(() => Promise.resolve()),
  decideOperatorNotification: vi.fn((..._args: unknown[]) =>
    Promise.resolve({ outcome: 'SEND_NEW', attentionItemId: 'a1', isMaterialChange: false })
  ),
  recordOperatorNotified: vi.fn(() => Promise.resolve()),
  gateState: { outcome: 'SEND_NEW' as string },
}))
vi.mock('@/lib/whatsapp/triggers', () => ({ enqueueEscalationPings }))
vi.mock('@/lib/whatsapp/operator-notification-gate', () => ({
  decideOperatorNotification: (...args: unknown[]) => {
    decideOperatorNotification(...(args as []))
    return Promise.resolve({ outcome: gateState.outcome, attentionItemId: 'a1', isMaterialChange: false })
  },
  recordOperatorNotified,
}))

import { escalateDriverQuestion } from './escalate-driver-question'

const ctx = {
  workspaceId: 'ws-1',
  callerRole: 'driver' as const,
  operatorId: 42,
  requestId: 'req-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  gateState.outcome = 'SEND_NEW'
})

describe('escalate_to_owner — routes through the shared notification gate', () => {
  it('a genuinely new question pings the owner and stamps the ledger', async () => {
    const result = await escalateDriverQuestion.execute({ question: 'Can I drop the cooler at the dock?' }, ctx)
    expect(result.ok).toBe(true)
    expect(enqueueEscalationPings).toHaveBeenCalledTimes(1)
    expect(recordOperatorNotified).toHaveBeenCalledTimes(1)
    expect(decideOperatorNotification).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', subjectType: 'driver_question', priority: 'decision' })
    )
  })

  it('the same driver asking the same question again does not re-ping while suppressed', async () => {
    gateState.outcome = 'SUPPRESS_RECENTLY_NOTIFIED'
    const result = await escalateDriverQuestion.execute({ question: 'Can I drop the cooler at the dock?' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ escalated: false, alreadyNotified: true })
    expect(enqueueEscalationPings).not.toHaveBeenCalled()
  })

  it('two different drivers asking the identical question get independent subject keys', async () => {
    await escalateDriverQuestion.execute({ question: 'What time is pickup?' }, { ...ctx, operatorId: 1 })
    await escalateDriverQuestion.execute({ question: 'What time is pickup?' }, { ...ctx, operatorId: 2 })
    const ids = decideOperatorNotification.mock.calls.map((c) => (c[0] as { subjectId: string }).subjectId)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('rejects a too-short question before touching the gate', async () => {
    const result = await escalateDriverQuestion.execute({ question: 'hi' }, ctx)
    expect(result.ok).toBe(false)
    expect(decideOperatorNotification).not.toHaveBeenCalled()
  })
})
