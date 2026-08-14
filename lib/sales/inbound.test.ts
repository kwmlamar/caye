import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  lead: { id: 'lead-1' } as { id: string } | null,
  conversation: { metadata: {}, last_sender_type: 'customer' } as { metadata: Record<string, unknown>; last_sender_type: string } | null,
  lifecycle: vi.fn(),
  context: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: table === 'outreach_leads' ? state.lead : state.conversation }),
      }
      return query
    },
  }),
}))
vi.mock('./lifecycle', () => ({ recordSalesLifecycleEvent: state.lifecycle }))
vi.mock('./context', () => ({ buildSalesLeadContext: state.context }))
vi.mock('server-only', () => ({}))

import { handleSalesInbound } from './inbound'

const inbound = { workspaceId: 'workspace-1', senderEmail: 'prospect@example.test', conversationId: 'conversation-1', currentChannelMessageId: 'message-1' }

describe('Sales inbound boundary', () => {
  beforeEach(() => {
    state.lead = { id: 'lead-1' }
    state.conversation = { metadata: {}, last_sender_type: 'customer' }
    state.lifecycle.mockReset()
    state.context.mockReset().mockResolvedValue({ id: 'lead-1' })
  })

  it.each([
    ['human reply', { subject: 'Re: Caye', body: 'How much does it cost?' }, 'eligible', 'human_reply_received'],
    ['OOO', { subject: 'Automatic reply: Away', body: 'I am currently out of the office.' }, 'ignore', 'automated_reply_received'],
    ['opt-out', { subject: 'Re: Caye', body: 'Please remove me from this list.' }, 'ignore', 'opted_out'],
    ['bounce', { subject: 'Undeliverable mail', body: 'Mailbox unavailable' }, 'ignore', 'bounce_or_delivery_failure'],
    ['unknown inbound', { subject: '', body: '' }, 'hold', 'inbound_unknown'],
  ])('records %s canonically before returning %s', async (_case, message, disposition, event) => {
    const result = await handleSalesInbound({ ...inbound, ...message })
    expect(result.disposition).toBe(disposition)
    expect(state.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-1', event, eventKey: `inbound:message-1:${event}`,
    }))
    expect(state.context).toHaveBeenCalledTimes(disposition === 'eligible' ? 1 : 0)
  })

  it('keeps internal and synthetic traffic out of lifecycle evidence and response context', async () => {
    const internal = await handleSalesInbound({ ...inbound, workspaceEmail: inbound.senderEmail, subject: 'Re:', body: 'send this' })
    const synthetic = await handleSalesInbound({ ...inbound, currentChannelMessageId: 'caye_test', subject: 'Re:', body: 'send this' })
    expect(internal.disposition).toBe('ignore')
    expect(synthetic.disposition).toBe('ignore')
    expect(state.lifecycle).not.toHaveBeenCalled()
    expect(state.context).not.toHaveBeenCalled()
  })

  it('records deterministic escalation once and never enters response context', async () => {
    const result = await handleSalesInbound({ ...inbound, currentChannelMessageId: null, subject: 'Re:', body: 'Can we negotiate the price?' })
    expect(result.disposition).toBe('escalate')
    expect(state.lifecycle).toHaveBeenCalledTimes(1)
    expect(state.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      event: 'escalated', eventKey: 'inbound:conversation-1:escalation:escalated',
    }))
    expect(state.context).not.toHaveBeenCalled()
  })
})
