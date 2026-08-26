import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
}))

const checkZohoDraftGateMock = vi.fn((_setting: unknown) => ({ allowed: true as const }))
vi.mock('@/lib/zoho-draft-gate', () => ({
  ZOHO_DRAFT_VERIFIED_KEY: 'zoho_draft_mode_verified',
  checkZohoDraftGate: (setting: unknown) => checkZohoDraftGateMock(setting),
}))

const createZohoReplyDraftMock = vi.fn(
  async (_to: string, _subject: string, _body: string, _threadId: string, _workspaceId: string) => ({
    draftId: 'draft_1' as string | null,
  })
)
vi.mock('@/lib/email-ai', () => ({
  createZohoReplyDraft: (to: string, subject: string, body: string, threadId: string, workspaceId: string) =>
    createZohoReplyDraftMock(to, subject, body, threadId, workspaceId),
}))

let conversationRow: Record<string, unknown> | null = {
  customer_id: 'cust_1',
  customer_name: 'Pam Ott',
  channel_type: 'email',
  channel_conversation_id: 'chan_1',
  metadata: { subject: 'Tour Booking: Pam Ott' },
}
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'platform_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { value: 'verified' } }),
            }),
          }),
        }
      }
      if (table === 'unified_conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: conversationRow }),
            }),
          }),
        }
      }
      if (table === 'caye_operator_messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({ limit: async () => ({ data: [] }) }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { draftInInbox } from './draft-in-inbox'

const ctx: ToolContext = {
  workspaceId: 'ws_1',
  callerRole: 'owner',
  requestId: 'req_1',
  operatorId: 1,
}

describe('draft_in_inbox — risk tier (2026-08-17 Pam Ott incident)', () => {
  it('is HIGH risk, gated through the same confirmation flow as send_reply', () => {
    // Raised from 'low' — the tool used to execute immediately with no
    // operator checkpoint, which is exactly what let it silently redirect
    // Mrs. Max to her email instead of showing a draft in WhatsApp.
    expect(draftInInbox.risk).toBe('high')
  })

  it('describes itself as staged/confirmed, not immediate', () => {
    expect(draftInInbox.description).toMatch(/HIGH-RISK/)
    expect(draftInInbox.description).toMatch(/stages it and returns it un-executed/)
    expect(draftInInbox.description).toMatch(/confirm_pending_action/)
  })

  it('explicitly tells the model the bare word "draft" does not mean this tool', () => {
    expect(draftInInbox.description).toMatch(/WORD "DRAFT" ALONE DOES NOT MEAN THIS TOOL/)
    expect(draftInInbox.description).toMatch(/COMPOSE AND SHOW IT HERE/)
    expect(draftInInbox.description).toMatch(/EXPLICITLY asks/)
  })

  it('still documents the attachment trigger this tool was originally built for', () => {
    expect(draftInInbox.description).toMatch(/USE THIS WHEN ATTACHMENTS ARE INVOLVED/)
  })
})

describe('draft_in_inbox — execute() behavior unchanged by the risk-tier move', () => {
  it('still refuses a non-email conversation', async () => {
    conversationRow = { ...conversationRow, channel_type: 'whatsapp' }
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: 'Hello' }, ctx)
    expect(result.ok).toBe(false)
    conversationRow = { ...conversationRow, channel_type: 'email' }
  })

  it('files the draft and reports it as NOT sent', async () => {
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: 'Hello Pam' }, ctx)
    expect(result.ok).toBe(true)
    expect((result.data as { sent: boolean }).sent).toBe(false)
    expect(createZohoReplyDraftMock).toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: '   ' }, ctx)
    expect(result.ok).toBe(false)
  })
})
