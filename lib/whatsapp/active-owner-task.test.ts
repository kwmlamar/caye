import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { isOwnerCompletionStatement, rankActiveOwnerTask, type OwnerTaskCandidate } from './active-owner-task'

const task = (overrides: Partial<OwnerTaskCandidate>): OwnerTaskCandidate => ({
  id: 'action-laney', workspaceId: 'bimini', operatorId: 1, toolName: 'send_reply',
  summary: 'Send to laney.broussard@nbcuni.com (email)',
  conversationId: 'conv-laney', customerName: 'Laney.Broussard@nbcuni.com',
  customerId: 'laney.broussard@nbcuni.com', createdAt: '2026-08-14T01:37:04Z',
  expiresAt: '2026-08-14T01:52:04Z', executedAt: null, cancelledAt: null,
  ownerHandledAt: null, droppedReportedAt: '2026-08-14T01:55:04Z', ...overrides,
})

describe('rankActiveOwnerTask', () => {
  it('reproduces Laney and ignores unrelated workspace pending work', () => {
    const result = rankActiveOwnerTask({
      candidates: [task({}), task({ id: 'vas', conversationId: 'conv-vas', summary: 'Send to Vasileios Gryllis', customerName: 'Vasileios Gryllis', customerId: 'vas@example.com' }), task({ id: 'rus', conversationId: 'conv-rus', summary: 'Send to Ruslan', customerName: 'Ruslan', customerId: 'ruslan@accessibletravelsolutions.com' })],
      previousCayeMessage: "Heads up — the reply to Laney.Broussard@nbcuni.com I lined up never went out, and it has now expired.",
    })
    expect(result.status).toBe('matched')
    if (result.status === 'matched') expect(result.task.id).toBe('action-laney')
  })

  it('keeps expired authorization available as task history', () => {
    expect(rankActiveOwnerTask({ candidates: [task({})], previousCayeMessage: 'The Laney.Broussard@nbcuni.com reply expired.' }).status).toBe('matched')
  })

  it('does not consider executed, cancelled, or owner-handled tasks', () => {
    for (const changed of [{ executedAt: 'now' }, { cancelledAt: 'now' }, { ownerHandledAt: 'now' }]) {
      expect(rankActiveOwnerTask({ candidates: [task(changed)], previousCayeMessage: 'Laney.Broussard@nbcuni.com' })).toEqual({ status: 'none' })
    }
  })

  it('lets an explicit customer override the preceding task', () => {
    const laney = task({})
    const ruslan = task({ id: 'rus', conversationId: 'conv-rus', summary: 'Reply to Ruslan', customerName: 'Ruslan Prakapovich', customerId: 'ruslan@accessibletravelsolutions.com' })
    const result = rankActiveOwnerTask({ candidates: [laney, ruslan], explicitRef: 'Ruslan', previousCayeMessage: 'The Laney reply expired.' })
    expect(result.status === 'matched' && result.task.id).toBe('rus')
  })

  it('asks upstream to clarify only when the conversational anchor is genuinely ambiguous', () => {
    const a = task({ id: 'a', summary: 'First reply to Laney' })
    const b = task({ id: 'b', summary: 'Second reply to Laney' })
    const result = rankActiveOwnerTask({ candidates: [a, b], previousCayeMessage: 'Two Laney replies expired.' })
    expect(result.status).toBe('ambiguous')
  })

  it('does not cross workspace or operator boundaries because candidates are pre-scoped', () => {
    const result = rankActiveOwnerTask({ candidates: [], previousCayeMessage: 'Laney reply expired.' })
    expect(result).toEqual({ status: 'none' })
  })

  it('is phrase-independent once the completion intent is established', () => {
    const phrases = ['I handled it', 'done', 'I replied myself', 'I called them', 'I already sent it', "don't worry about that one"]
    for (const _phrase of phrases) {
      const result = rankActiveOwnerTask({ candidates: [task({})], previousCayeMessage: 'The Laney.Broussard@nbcuni.com reply expired.' })
      expect(result.status === 'matched' && result.task.id).toBe('action-laney')
    }
  })

  it('resolves context identity across shared workflow types', () => {
    for (const toolName of ['send_reply', 'send_whatsapp_reply', 'confirm_booking', 'send_payment_link', 'resolve_escalation']) {
      const candidate = task({ id: toolName, toolName, referenceTerms: ['Jordan Smith', `booking-${toolName}`], customerName: 'Jordan Smith' })
      const result = rankActiveOwnerTask({ candidates: [candidate], previousCayeMessage: `Jordan Smith — ${toolName} is waiting.` })
      expect(result.status === 'matched' && result.task.id).toBe(toolName)
    }
  })

  it('follows a topic switch instead of a stale task', () => {
    const laney = task({})
    const jordan = task({ id: 'jordan', conversationId: 'conv-jordan', customerName: 'Jordan Smith', customerId: 'jordan@example.com' })
    const result = rankActiveOwnerTask({ candidates: [laney, jordan], previousCayeMessage: "Jordan Smith's payment follow-up is the one we're discussing now." })
    expect(result.status === 'matched' && result.task.id).toBe('jordan')
  })
})

describe('isOwnerCompletionStatement', () => {
  it('recognises completion semantics without resolving a customer', () => {
    for (const phrase of ['I handled it', 'done', 'I replied myself', 'I called them', 'I already sent it', "don't worry about that one"]) {
      expect(isOwnerCompletionStatement(phrase)).toBe(true)
    }
  })

  it('does not convert instructions or questions into external completion', () => {
    for (const phrase of ['send it', 'skip it', 'is it done?', 'can you call them?', 'do not send it']) {
      expect(isOwnerCompletionStatement(phrase)).toBe(false)
    }
  })
})
