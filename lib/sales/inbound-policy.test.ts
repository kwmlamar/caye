import { describe, expect, it } from 'vitest'
import { decideSalesInboundPolicy } from './inbound-policy'

describe('Sales inbound policy', () => {
  it('keeps a genuine prospect reply distinct from automation', () => {
    expect(decideSalesInboundPolicy('Re: Caye', 'How much does it cost?')).toEqual({ kind: 'human_reply' })
    expect(decideSalesInboundPolicy('Automatic reply: Away', 'I am currently out of the office.').kind).toBe('automated_ooo')
  })

  it('recognizes opt-outs and delivery failures before a model can reply', () => {
    expect(decideSalesInboundPolicy('Re: hello', 'Please remove me from this list.').kind).toBe('opt_out')
    expect(decideSalesInboundPolicy('Undeliverable mail', 'Mailbox unavailable').kind).toBe('bounce_or_delivery_failure')
  })

  it('does not turn owner or synthetic traffic into Sales evidence', () => {
    expect(decideSalesInboundPolicy('Re:', 'send this', { senderEmail: 'owner@caye.test', workspaceEmail: 'owner@caye.test' })).toEqual({ kind: 'internal' })
    expect(decideSalesInboundPolicy('Re:', 'send this', { synthetic: true })).toEqual({ kind: 'internal' })
  })

  it('escalates deterministic commercial exceptions before general handling', () => {
    expect(decideSalesInboundPolicy('Re:', 'Can we negotiate the price?').kind).toBe('deterministic_escalation')
    expect(decideSalesInboundPolicy('Re:', 'Can I speak with Lamar?').kind).toBe('deterministic_escalation')
    expect(decideSalesInboundPolicy('Re:', 'Can you guarantee 20 bookings?').kind).toBe('deterministic_escalation')
  })
})
