import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  lead: { id: 'lead-1' } as { id: string } | null,
  conversation: { metadata: {}, last_sender_type: 'customer', contact_id: 'contact-1' } as { metadata: Record<string, unknown>; last_sender_type: string; contact_id: string | null } | null,
  lifecycle: vi.fn(),
  context: vi.fn(),
  bridge: vi.fn(),
  leadLookupEmails: [] as string[],
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          if (table === 'outreach_leads' && column === 'lead_email' && typeof value === 'string') state.leadLookupEmails.push(value)
          return query
        },
        maybeSingle: async () => ({ data: table === 'outreach_leads' ? state.lead : state.conversation }),
      }
      return query
    },
  }),
}))
vi.mock('./lifecycle', () => ({ recordSalesLifecycleEvent: state.lifecycle }))
vi.mock('./context', () => ({ buildSalesLeadContext: state.context }))
vi.mock('./opportunity-bridge', () => ({ bridgeSalesInboundToWork: state.bridge }))
vi.mock('server-only', () => ({}))

import { handleSalesInbound } from './inbound'

const inbound = { workspaceId: 'workspace-1', senderEmail: 'prospect@example.test', conversationId: 'conversation-1', currentChannelMessageId: 'message-1', receivedAt: '2026-08-14T00:00:00Z' }

describe('Sales inbound boundary', () => {
  beforeEach(() => {
    state.lead = { id: 'lead-1' }
    state.conversation = { metadata: {}, last_sender_type: 'customer', contact_id: 'contact-1' }
    state.lifecycle.mockReset()
    state.context.mockReset().mockResolvedValue({ id: 'lead-1' })
    state.bridge.mockReset().mockResolvedValue({ relationshipId: 'relationship-1', opportunityId: null })
    state.leadLookupEmails = []
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
    expect(state.bridge).toHaveBeenCalledTimes(disposition === 'eligible' ? 1 : 0)
    if (disposition === 'eligible') {
      expect(state.bridge).toHaveBeenCalledWith(expect.objectContaining({ observedAt: inbound.receivedAt }))
    }
  })

  it('keeps internal and synthetic traffic out of lifecycle evidence and response context', async () => {
    const internal = await handleSalesInbound({ ...inbound, workspaceEmail: inbound.senderEmail, subject: 'Re:', body: 'send this' })
    const synthetic = await handleSalesInbound({ ...inbound, currentChannelMessageId: 'caye_test', subject: 'Re:', body: 'send this' })
    expect(internal.disposition).toBe('ignore')
    expect(synthetic.disposition).toBe('ignore')
    expect(state.lifecycle).not.toHaveBeenCalled()
    expect(state.context).not.toHaveBeenCalled()
    expect(state.bridge).not.toHaveBeenCalled()
  })

  it('records deterministic escalation once and never enters response context', async () => {
    const result = await handleSalesInbound({ ...inbound, currentChannelMessageId: null, subject: 'Re:', body: 'Can we negotiate the price?' })
    expect(result.disposition).toBe('escalate')
    expect(state.lifecycle).toHaveBeenCalledTimes(1)
    expect(state.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      event: 'escalated', eventKey: 'inbound:conversation-1:escalation:escalated',
    }))
    expect(state.context).not.toHaveBeenCalled()
    expect(state.bridge).not.toHaveBeenCalled()
  })

  it('handles “remove me” as an autonomous compliance action, without a draft or owner hold', async () => {
    const result = await handleSalesInbound({ ...inbound, subject: 'Re:', body: 'remove me.' })
    expect(result).toMatchObject({ disposition: 'ignore', reason: 'opt_out' })
    expect(state.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      event: 'opted_out', eventKey: 'inbound:message-1:opted_out',
      // The lifecycle RPC atomically writes the suppression timestamp,
      // terminal stage, cadence stop, signal, and replay receipt.
    }))
    expect(state.context).not.toHaveBeenCalled()
    expect(state.bridge).not.toHaveBeenCalled()
  })

  it('suppresses the recipient named by a bounce notification, not the mailer-daemon sender', async () => {
    await handleSalesInbound({
      ...inbound,
      senderEmail: 'mailer-daemon@example.test',
      subject: 'Undeliverable mail',
      body: 'Final-Recipient: rfc822; prospect@example.test',
    })
    expect(state.leadLookupEmails).toContain('prospect@example.test')
    expect(state.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-1', event: 'bounce_or_delivery_failure',
    }))
  })

  it('uses the same durable lifecycle receipt key when a provider replays the same DSN', async () => {
    const bounce = { ...inbound, senderEmail: 'mailer-daemon@example.test', subject: 'Undeliverable mail', body: 'Final-Recipient: rfc822; prospect@example.test' }
    await handleSalesInbound(bounce)
    await handleSalesInbound(bounce)
    const keys = state.lifecycle.mock.calls.map(([input]) => input.eventKey)
    expect(keys).toEqual(['inbound:message-1:bounce_or_delivery_failure', 'inbound:message-1:bounce_or_delivery_failure'])
  })

  it('does not suppress an arbitrary address when a DSN contains no explicit recipient', async () => {
    state.lead = null
    await handleSalesInbound({ ...inbound, senderEmail: 'mailer-daemon@example.test', subject: 'Undeliverable mail', body: 'Delivery failed for a recipient listed below.' })
    expect(state.leadLookupEmails).toContain('mailer-daemon@example.test')
    expect(state.lifecycle).not.toHaveBeenCalled()
  })
})
