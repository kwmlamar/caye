import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/whatsapp/channel-dispatch', () => ({ dispatchOperatorReply: vi.fn() }))
vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(),
  resolveOpenEscalations: vi.fn(),
}))
vi.mock('../../logistics-grounding', () => ({ unsupportedLogisticsTimeClaims: vi.fn(() => []) }))

import { sendReply } from './send-reply'

describe('send_reply operator drafting contract', () => {
  it('requires an explicit draft command to produce the draft instead of advisory debate', () => {
    expect(sendReply.description).toMatch(/EXPLICIT DRAFT COMMANDS TAKE PRIORITY/)
    expect(sendReply.description).toMatch(/DO THE DRAFT IN THIS TURN/)
    expect(sendReply.description).toMatch(/Do not replace the requested draft with strategy commentary/)
  })

  it('treats current operator facts as newer than stale remembered guidance', () => {
    expect(sendReply.description).toMatch(/CURRENT-TURN factual instruction is authoritative/)
    expect(sendReply.description).toMatch(/newer owner-direct facts outrank older conflicting owner-direct facts/)
    expect(sendReply.description).toMatch(/Never invent a departure minimum/)
  })
})
