import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/** Mirrors the exact row stageProposedReply() (./edit.ts) inserts. */
interface StagedReplyRow {
  conversation_id: string
  channel_message_id: string | null
  sender_type: string
  content: string
  message_type: string
  sent_at: string
  status: string
  is_internal: boolean
  metadata: {
    generated_by: string
    hold_reason: string
    proposed_reply: string
  }
}

const insertMock = vi.fn(async (_row: StagedReplyRow) => ({ error: null }))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'unified_messages') {
        return { insert: (row: StagedReplyRow) => insertMock(row) }
      }
      if (table === 'workspace_ai_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
      }
      if (table === 'customers') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

const loggedMessagesCreateMock = vi.fn(async (..._args: unknown[]) => ({
  content: [{ type: 'text', text: 'a composed reply Caye made up' }],
}))
vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: (...args: unknown[]) => loggedMessagesCreateMock(...args),
}))

import { actionEdit, stripDraftMarker } from './edit'
import type { PendingHeldItem } from '../pending'

const LANEY: PendingHeldItem = {
  index: 1,
  conversationId: 'conv-laney',
  contactName: 'Laney Broussard',
  channelType: 'whatsapp',
  reason: 'guest reply',
  proposedReply: null,
  lastMessagePreview: 'What time is pickup?',
  lastMessageAt: null,
}

const ctx = { workspaceId: 'ws-1' }

describe('stripDraftMarker', () => {
  it('strips a leading or trailing (Draft) marker, case-insensitively', () => {
    expect(stripDraftMarker('(Draft) Hi Laney, pickup is at 9.')).toBe('Hi Laney, pickup is at 9.')
    expect(stripDraftMarker('Hi Laney, pickup is at 9. (draft)')).toBe('Hi Laney, pickup is at 9.')
    expect(stripDraftMarker('Hi Laney, pickup is at 9. ( DRAFT )')).toBe('Hi Laney, pickup is at 9.')
  })

  it('leaves ordinary text untouched', () => {
    expect(stripDraftMarker('Hi Laney, pickup is at 9.')).toBe('Hi Laney, pickup is at 9.')
  })
})

describe('actionEdit — verbatim drafts (CAY-90, Laney incident)', () => {
  beforeEach(() => {
    insertMock.mockClear()
    loggedMessagesCreateMock.mockClear()
  })

  it('stages the operator-supplied draft exactly, without recomposing it', async () => {
    const ownerDraft =
      '(Draft) Hi Laney! Max will meet you at 9 AM for the ferry; transport to the dock is around 11.'
    const result = await actionEdit(
      ctx,
      { item_ref: 'Laney', instruction: ownerDraft, verbatim: true },
      [LANEY]
    )

    // The LLM re-composition step must never run for a verbatim draft — that
    // second model call, with no strong grounding, is what produced an
    // unrelated complaint/apology reply in place of Mrs. Max's own words.
    expect(loggedMessagesCreateMock).not.toHaveBeenCalled()

    expect(insertMock).toHaveBeenCalledTimes(1)
    const staged = insertMock.mock.calls[0][0]
    expect(staged.metadata.proposed_reply).toBe(
      'Hi Laney! Max will meet you at 9 AM for the ferry; transport to the dock is around 11.'
    )
    expect(staged.conversation_id).toBe('conv-laney')

    expect(result.ackBody).toContain(
      'Hi Laney! Max will meet you at 9 AM for the ferry; transport to the dock is around 11.'
    )
    expect(result.tag?.status).toBe('ok')
  })

  it('repeating the identical draft after a failed interaction stages the same text again, never boilerplate', async () => {
    const ownerDraft = '(Draft) Thanks so much for your patience — see you at 9!'

    await actionEdit(ctx, { item_ref: 'Laney', instruction: ownerDraft, verbatim: true }, [LANEY])
    await actionEdit(ctx, { item_ref: 'Laney', instruction: ownerDraft, verbatim: true }, [LANEY])

    expect(loggedMessagesCreateMock).not.toHaveBeenCalled()
    expect(insertMock).toHaveBeenCalledTimes(2)
    const first = insertMock.mock.calls[0][0].metadata.proposed_reply
    const second = insertMock.mock.calls[1][0].metadata.proposed_reply
    expect(first).toBe('Thanks so much for your patience — see you at 9!')
    expect(second).toBe(first)
  })

  it('"use this instead" (verbatim) fully supersedes whatever was drafted before', async () => {
    const withExisting: PendingHeldItem = { ...LANEY, proposedReply: 'Some earlier, unrelated draft.' }
    const ownerDraft = 'Use this instead: Hi Laney, meeting you dockside at 9, see you soon!'

    const result = await actionEdit(
      ctx,
      { item_ref: 'Laney', instruction: ownerDraft, verbatim: true },
      [withExisting]
    )

    expect(loggedMessagesCreateMock).not.toHaveBeenCalled()
    const staged = insertMock.mock.calls[0][0]
    expect(staged.metadata.proposed_reply).toBe(ownerDraft)
    expect(result.ackBody).not.toContain('Some earlier, unrelated draft.')
  })
})

describe('actionEdit — genuine revision instructions (unchanged behavior)', () => {
  beforeEach(() => {
    insertMock.mockClear()
    loggedMessagesCreateMock.mockClear()
  })

  it('still composes via the model when the operator describes a change rather than supplying text', async () => {
    const result = await actionEdit(
      ctx,
      { item_ref: 'Laney', instruction: 'add meet and greet' },
      [LANEY]
    )

    expect(loggedMessagesCreateMock).toHaveBeenCalledTimes(1)
    const staged = insertMock.mock.calls[0][0]
    expect(staged.metadata.proposed_reply).toBe('a composed reply Caye made up')
    expect(result.tag?.status).toBe('ok')
  })
})
