import { describe, expect, it } from 'vitest'
import { transitionForEvent } from './lifecycle-transitions'

const at = '2026-08-14T12:00:00.000Z'
const contacted = { stage: 'contacted' as const, first_touch_sent_at: at, touches_sent: 1, opted_out_at: null }

describe('Sales lifecycle transitions', () => {
  it('records a real delivered send and never treats a provider failure as one', () => {
    expect(transitionForEvent({ ...contacted, stage: 'sourced', first_touch_sent_at: null, touches_sent: 0 }, 'first_touch_sent', at)).toMatchObject({
      stage: 'contacted', first_touch_sent_at: at, touches_sent: 1,
    })
  })

  it('advances only a human reply to engaged, never to qualified', () => {
    expect(transitionForEvent(contacted, 'human_reply_received', at)).toMatchObject({ stage: 'engaged', last_inbound_kind: 'human_reply' })
    expect(transitionForEvent(contacted, 'automated_reply_received', at)).toEqual({ last_inbound_kind: 'automated_ooo', outreach_deferred_at: at })
  })

  it('keeps terminal lead state terminal when a late duplicate-like event arrives', () => {
    expect(transitionForEvent({ ...contacted, stage: 'disqualified', opted_out_at: at }, 'human_reply_received', at)).toEqual({})
  })
})
