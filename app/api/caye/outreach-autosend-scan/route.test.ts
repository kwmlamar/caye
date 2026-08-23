import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatch, update } = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ success: true, channelType: 'email' })),
  update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ from: () => ({ update }) }),
}))
vi.mock('@/lib/whatsapp/channel-dispatch', () => ({ dispatchOperatorReply: dispatch }))
vi.mock('@/lib/outreach-first-touch', () => ({
  generateOutreachFirstTouchDraft: vi.fn(async () => { throw new Error('a parked draft must be revalidated, not regenerated') }),
}))
vi.mock('@/lib/outreach-nudge', () => ({ generateOutreachFollowupDraft: vi.fn() }))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: (_name: string, fn: () => unknown) => fn() }))
vi.mock('@/lib/whatsapp/triggers', () => ({ enqueueHoldPing: vi.fn() }))
vi.mock('@/lib/sales/lifecycle', () => ({ recordSalesLifecycleEvent: vi.fn() }))

import { processLead } from './route'

describe('outreach autosend parked-draft recovery', () => {
  beforeEach(() => {
    dispatch.mockClear()
    update.mockClear()
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
      'caye-dashboard',
      'outreach:send_first_touch:lead-1'
    )
  })
})
