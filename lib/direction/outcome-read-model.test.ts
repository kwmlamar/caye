import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))

import { isAttributedOutreachReplyReceipt } from './outcome-read-model'

describe('Direction outreach reply evidence', () => {
  it('accepts only human-reply receipts written by the correlated outreach seam', () => {
    expect(isAttributedOutreachReplyReceipt({
      lead_id: 'lead-1',
      event: 'human_reply_received',
      event_key: 'inbound:outreach:provider-message-1:human_reply_received',
    })).toBe(true)
  })

  it.each([
    ['legacy ambiguous human reply', 'human_reply_received', 'inbound:provider-message-1:human_reply_received'],
    ['auto reply', 'automated_reply_received', 'inbound:outreach:provider-message-1:automated_reply_received'],
    ['bounce', 'bounce_or_delivery_failure', 'inbound:outreach:provider-message-1:bounce_or_delivery_failure'],
    ['missing event key', 'human_reply_received', null],
  ])('rejects %s as canonical outreach reply evidence', (_case, event, eventKey) => {
    expect(isAttributedOutreachReplyReceipt({ lead_id: 'lead-1', event, event_key: eventKey })).toBe(false)
  })
})
