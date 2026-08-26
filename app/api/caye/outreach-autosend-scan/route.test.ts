import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatch, update, firstTouch, followup, lifecycle, receipt } = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ success: true, channelType: 'email' })),
  update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  firstTouch: vi.fn(),
  followup: vi.fn(),
  lifecycle: vi.fn(),
  receipt: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ from: () => ({ update }) }),
}))
vi.mock('@/lib/whatsapp/channel-dispatch', () => ({ dispatchOperatorReply: dispatch }))
vi.mock('@/lib/outreach-first-touch', () => ({
  generateOutreachFirstTouchDraft: (...args: unknown[]) => firstTouch(...args),
}))
vi.mock('@/lib/outreach-nudge', () => ({ generateOutreachFollowupDraft: (...args: unknown[]) => followup(...args) }))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: (_name: string, fn: () => unknown) => fn() }))
vi.mock('@/lib/whatsapp/triggers', () => ({ enqueueHoldPing: vi.fn() }))
vi.mock('@/lib/sales/lifecycle', () => ({ recordSalesLifecycleEvent: lifecycle }))
vi.mock('@/lib/outreach-first-touch-capacity', () => ({ reserveFirstTouchCapacity: vi.fn(async () => true) }))
vi.mock('@/lib/outreach-bounce-evidence', () => ({ ensureOutreachOutboundReceipt: receipt }))

import { processLead } from './route'

describe('outreach autosend parked-draft recovery', () => {
  beforeEach(() => {
    dispatch.mockClear()
    update.mockClear()
    firstTouch.mockReset()
    followup.mockReset()
    lifecycle.mockReset()
    receipt.mockReset()
  })

  it('revalidates and sends an eligible queued first touch without owner approval', async () => {
    const summary = {
      workspaces_scanned: 0, leads_examined: 0, first_touch_sent: 0, followups_sent: 0,
      held_for_review: 0, escalated: 0, disqualified: 0, marked_cold: 0, no_action: 0,
      leads_considered: 0, errors: [], rejection_reasons: {}, primary_zero_send_reason: null,
    }

    const consumed = await processLead({
      lead: {
        id: 'lead-1', lead_email: 'owner@example.com', business_name: 'Example Tours', contact_name: 'Ari',
        demo_token: 'demo-1', stage: 'sourced', first_touch_sent_at: null, touches_sent: 0,
        last_touch_sent_at: null, opted_out_at: null, last_inbound_kind: null, outreach_deferred_at: null,
        disqualified_reason: null, created_at: '2026-08-20T00:00:00Z',
      },
      workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false,
      remaining: 1, now: new Date('2026-08-23T12:00:00Z'), summary,
      prefetchedConversation: {
        id: 'conversation-1', customer_id: 'owner@example.com', last_sender_type: 'business', human_agent_enabled: true,
        metadata: { source: 'outreach_leads', lead_id: 'lead-1', hold_kind: 'outreach_first_touch', subject: 'Quick question', proposed_reply: 'Hi Ari,' },
      },
    })

    expect(consumed).toBe(1)
    expect(summary.first_touch_sent).toBe(1)
    expect(dispatch).toHaveBeenCalledWith(
      'conversation-1',
      expect.stringContaining('Hi Ari,'),
      'caye-outreach-autonomous',
      'outreach:first_touch:lead-1'
    )
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ autonomy: expect.objectContaining({ decision: 'act_and_audit', atomic_recipients: 1 }) }),
    }))
  })

  it('executes a fresh eligible first touch through the autonomous dispatch boundary', async () => {
    firstTouch.mockResolvedValue({ ok: true, subject: 'Quick question', body: 'Hi Ari,' })
    const summary = emptySummary()
    const consumed = await processLead({
      lead: sourcedLead(), workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false,
      remaining: 50, now: new Date('2026-08-23T12:00:00Z'), summary,
      prefetchedConversation: conversation(),
    })
    expect(consumed).toBe(1)
    expect(dispatch).toHaveBeenCalledWith('conversation-1', expect.stringContaining('Hi Ari,'), 'caye-outreach-autonomous', 'outreach:first_touch:lead-1')
    expect(summary.held_for_review).toBe(0)
  })

  it('executes a due follow-up autonomously but never spends first-touch capacity', async () => {
    followup.mockResolvedValue({ ok: true, content: 'Hi Ari, following up.' })
    const summary = emptySummary()
    const consumed = await processLead({
      lead: { ...sourcedLead(), stage: 'contacted', first_touch_sent_at: '2026-08-20T12:00:00Z', touches_sent: 1 },
      workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false,
      remaining: 0, now: new Date('2026-08-23T12:00:00Z'), summary, prefetchedConversation: conversation(),
    })
    expect(consumed).toBe(0)
    expect(summary.followups_sent).toBe(1)
    expect(dispatch).toHaveBeenCalledWith('conversation-1', expect.stringContaining('following up'), 'caye-outreach-autonomous', 'outreach:followup:lead-1:touch:2')
  })

  it('uses a distinct durable idempotency key for cadence touch 3', async () => {
    followup.mockResolvedValue({ ok: true, content: 'Hi Ari, last follow-up.' })
    const summary = emptySummary()
    await processLead({
      lead: { ...sourcedLead(), stage: 'contacted', first_touch_sent_at: '2026-08-10T12:00:00Z', touches_sent: 2, last_touch_sent_at: '2026-08-16T12:00:00Z' },
      workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false,
      remaining: 0, now: new Date('2026-08-23T12:00:00Z'), summary, prefetchedConversation: conversation(),
    })
    expect(dispatch).toHaveBeenCalledWith('conversation-1', expect.stringContaining('last follow-up'), 'caye-outreach-autonomous', 'outreach:followup:lead-1:touch:3')
  })

  it('repairs lifecycle after an idempotent retry without issuing another send', async () => {
    firstTouch.mockResolvedValue({ ok: true, subject: 'Quick question', body: 'Hi Ari,' })
    dispatch.mockResolvedValueOnce({ success: true, channelType: 'email', messageId: 'message-1', deduped: true })
    await processLead({ lead: sourcedLead(), workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false, remaining: 1, now: new Date('2026-08-23T12:00:00Z'), summary: emptySummary(), prefetchedConversation: conversation() })
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({ event: 'first_touch_sent', eventKey: 'outbound:message-1' }))
  })

  it('keeps a legitimately paused parked draft stopped and records its structured park reason', async () => {
    const summary = emptySummary()
    await processLead({
      lead: sourcedLead(), workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: true,
      remaining: 1, now: new Date('2026-08-23T12:00:00Z'), summary,
      prefetchedConversation: { ...conversation(), human_agent_enabled: true, metadata: { source: 'outreach_leads', lead_id: 'lead-1', hold_kind: 'outreach_first_touch', subject: 'Quick question', proposed_reply: 'Hi Ari,' } },
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outreach_park: expect.objectContaining({ reason: 'outreach_paused' }) }) }))
  })

  it('does not dispatch a follow-up after an opt-out, even if it is otherwise due', async () => {
    const summary = emptySummary()
    await processLead({
      lead: { ...sourcedLead(), stage: 'contacted', first_touch_sent_at: '2026-08-20T12:00:00Z', touches_sent: 1, opted_out_at: '2026-08-22T00:00:00Z' },
      workspaceId: 'workspace-1', accountId: 'account-1', workspaceVoice: '', outreachPaused: false,
      remaining: 50, now: new Date('2026-08-23T12:00:00Z'), summary, prefetchedConversation: conversation(),
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(summary.no_action).toBe(1)
  })
})

function emptySummary() {
  return { workspaces_scanned: 0, leads_examined: 0, first_touch_sent: 0, followups_sent: 0, held_for_review: 0, escalated: 0, disqualified: 0, marked_cold: 0, no_action: 0, leads_considered: 0, errors: [], rejection_reasons: {}, primary_zero_send_reason: null }
}

function sourcedLead() {
  return { id: 'lead-1', lead_email: 'owner@example.com', business_name: 'Example Tours', contact_name: 'Ari', demo_token: 'demo-1', stage: 'sourced' as const, first_touch_sent_at: null, touches_sent: 0, last_touch_sent_at: null, opted_out_at: null, last_inbound_kind: null, outreach_deferred_at: null, disqualified_reason: null, created_at: '2026-08-20T00:00:00Z' }
}

function conversation() {
  return { id: 'conversation-1', customer_id: 'owner@example.com', last_sender_type: 'business', human_agent_enabled: false, metadata: { source: 'outreach_leads', lead_id: 'lead-1', subject: 'Quick question' } }
}
