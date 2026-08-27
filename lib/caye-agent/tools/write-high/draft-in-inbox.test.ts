import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
}))

const checkZohoDraftGateMock = vi.fn(
  (_setting: unknown): { allowed: boolean; reason?: string } => ({ allowed: true, reason: undefined })
)
vi.mock('@/lib/zoho-draft-gate', () => ({
  ZOHO_DRAFT_VERIFIED_KEY: 'zoho_draft_mode_verified',
  checkZohoDraftGate: (setting: unknown) => checkZohoDraftGateMock(setting),
}))

let nextDraftOutcome: 'success' | Error = 'success'
const createZohoReplyDraftMock = vi.fn(async (_to: string, _subject: string, _body: string, _threadId: string, _workspaceId: string) => {
  if (nextDraftOutcome instanceof Error) throw nextDraftOutcome
  return { draftId: 'zoho_draft_1' as string | null }
})
vi.mock('@/lib/email-ai', () => ({
  createZohoReplyDraft: (to: string, subject: string, body: string, threadId: string, workspaceId: string) =>
    createZohoReplyDraftMock(to, subject, body, threadId, workspaceId),
}))

let conversationRow: Record<string, unknown> | null = {
  customer_id: 'cust_1',
  customer_name: 'Jeff Dworkin',
  channel_type: 'email',
  channel_conversation_id: 'chan_jeff',
  metadata: { subject: 'Tour Booking: Jeff Dworkin' },
}
let platformSettingValue: unknown = 'verified'

/**
 * A minimal in-memory stand-in for the one `caye_operator_messages` row
 * updateActiveWork reads/writes, so these tests can assert the exact status
 * ('failed' vs 'uncertain' vs 'completed') each failure class leaves behind
 * — not just the returned ToolResult. Mirrors the row shape
 * lib/whatsapp/active-work.ts actually reads (id, intent.active_work).
 */
function makeActiveWorkRow(status: string) {
  return {
    id: 'jeff-work',
    intent: {
      kind: 'edit',
      active_work: {
        entityRef: 'jeffd@jldhomes.com',
        operation: 'customer_reply_draft',
        artifact: 'previous draft text',
        status,
        createdAt: new Date().toISOString(),
      },
    },
  }
}
let activeWorkRow: ReturnType<typeof makeActiveWorkRow> | null = null
const activeWorkUpdates: Record<string, unknown>[] = []

function operatorMessagesTable() {
  const filters: Record<string, unknown> = {}
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return builder
    },
    maybeSingle: async () => {
      if (!activeWorkRow) return { data: null }
      if (filters.id && filters.id !== activeWorkRow.id) return { data: null }
      return { data: activeWorkRow }
    },
    update: (value: Record<string, unknown>) => {
      activeWorkUpdates.push(value)
      if (activeWorkRow) activeWorkRow = { ...activeWorkRow, intent: value.intent as typeof activeWorkRow.intent }
      return { eq: async () => ({ data: null }) }
    },
  }
  return builder
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'platform_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { value: platformSettingValue } }),
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
        return operatorMessagesTable()
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { draftInInbox } from './draft-in-inbox'

const baseCtx: ToolContext = {
  workspaceId: 'ws_1',
  callerRole: 'owner',
  requestId: 'req_1',
  operatorId: 1,
}

/** ctx with an active-work record attached, matching activeWorkRow above. */
const ctxWithActiveWork: ToolContext = {
  ...baseCtx,
  activeWork: {
    sourceMessageId: 'jeff-work',
    entityRef: 'jeffd@jldhomes.com',
    operation: 'customer_reply_draft',
  },
}

beforeEach(() => {
  nextDraftOutcome = 'success'
  checkZohoDraftGateMock.mockReturnValue({ allowed: true, reason: undefined })
  platformSettingValue = 'verified'
  conversationRow = {
    customer_id: 'cust_1',
    customer_name: 'Jeff Dworkin',
    channel_type: 'email',
    channel_conversation_id: 'chan_jeff',
    metadata: { subject: 'Tour Booking: Jeff Dworkin' },
  }
  activeWorkRow = makeActiveWorkRow('ready')
  activeWorkUpdates.length = 0
  createZohoReplyDraftMock.mockClear()
})

describe('draft_in_inbox — risk tier (2026-08-17 Pam Ott incident)', () => {
  it('is HIGH risk, gated through the same confirmation flow as send_reply', () => {
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

describe('draft_in_inbox — execute() basics', () => {
  it('still refuses a non-email conversation', async () => {
    conversationRow = { ...conversationRow, channel_type: 'whatsapp' }
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: 'Hello' }, baseCtx)
    expect(result.ok).toBe(false)
  })

  it('files the draft and reports it as NOT sent', async () => {
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: 'Hello Jeff' }, baseCtx)
    expect(result.ok).toBe(true)
    expect((result.data as { sent: boolean }).sent).toBe(false)
    expect(createZohoReplyDraftMock).toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    const result = await draftInInbox.execute({ conversation_id: 'conv_1', body: '   ' }, baseCtx)
    expect(result.ok).toBe(false)
  })
})

describe('draft_in_inbox — success (CAY-139 test 1: authoritative provider identity, completed active work)', () => {
  it('returns the exact real Zoho draft id and marks active work completed with the exact attempted body', async () => {
    const result = await draftInInbox.execute(
      { conversation_id: 'conv_jeff', body: 'Hi Jeff, thank you for the photos.' },
      ctxWithActiveWork
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe('SUCCESS')
    expect((result.data as { draft_id: string | null }).draft_id).toBe('zoho_draft_1')
    expect((result.data as { sent: boolean }).sent).toBe(false)

    expect(activeWorkUpdates).toHaveLength(1)
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('completed')
    expect(active.artifact).toBe('Hi Jeff, thank you for the photos.')
  })
})

describe('draft_in_inbox — rate limit (CAY-139 test 2: bounded retry, no duplicate on eventual success)', () => {
  it('classifies a 429 as FAILED_RETRYABLE and preserves the draft body, marking active work failed (not completed, not uncertain)', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 429, code 429): {"status":{"code":429}}')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'revised body' }, ctxWithActiveWork)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('FAILED_RETRYABLE')
    expect(result.retryable).toBe(true)
    expect(result.error_code).toBe('ZOHO_DRAFT_RATE_LIMITED')
    expect((result.data as { draft_body: string }).draft_body).toBe('revised body')

    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('failed')
  })

  it('a subsequent successful attempt after the rate limit produces exactly one draft', async () => {
    // First attempt: rate limited, nothing created.
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 429, code 429): {}')
    const first = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(first.ok).toBe(false)

    // Second attempt (the orchestrator's own retry, or an operator-driven
    // re-ask): provider now accepts.
    nextDraftOutcome = 'success'
    const second = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(second.ok).toBe(true)
    expect(createZohoReplyDraftMock).toHaveBeenCalledTimes(2)
    // Only the second call actually created anything — createZohoReplyDraft
    // is the sole creation boundary, so "called twice" here means one
    // rejected attempt (no draft) plus one accepted attempt (one draft), not
    // two drafts.
  })
})

describe('draft_in_inbox — auth blocked (CAY-139 test 3: no retry storm, actionable reconnect result)', () => {
  it('classifies 401/403 as NEEDS_HUMAN, non-retryable, and marks active work failed', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 401, code 401): unauthorized')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('ZOHO_DRAFT_AUTH_REQUIRED')
    expect(result.retryable).toBe(false)
    expect(result.error).toMatch(/reconnected/i)

    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('failed')
  })

  it('classifies a pre-network getZohoContext throw ("No active Zoho account...") as auth-required, NOT ambiguous/uncertain', async () => {
    // Self-review catch (CAY-139): lib/zoho-token.ts's getZohoContext throws
    // this BEFORE any HTTP call is made when the workspace has no connected
    // Zoho account at all. It carries no HTTP status and no "401"/"403"
    // literal, so it would previously have fallen through to the
    // network/timeout branch and been misreported as "uncertain whether it
    // saved" — actively misleading, since nothing was ever attempted.
    nextDraftOutcome = new Error('No active Zoho account for workspace ws_1')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('ZOHO_DRAFT_AUTH_REQUIRED')
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('failed')
    expect(active.status).not.toBe('uncertain')
  })

  it('classifies "No refresh token..." and "Token refresh failed..." the same way', async () => {
    for (const message of [
      'No refresh token for Zoho account acc_1 — user must reconnect',
      'Token refresh failed for Zoho account acc_1',
    ]) {
      activeWorkUpdates.length = 0
      nextDraftOutcome = new Error(message)
      const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
      expect(result.error_code).toBe('ZOHO_DRAFT_AUTH_REQUIRED')
      const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
      expect(active.status).toBe('failed')
    }
  })
})

describe('draft_in_inbox — provider accepted but returned no draft id (CAY-139 self-review catch: success misclassification)', () => {
  it('does NOT report unconditional success when createZohoReplyDraft resolves with draftId: null', async () => {
    createZohoReplyDraftMock.mockResolvedValueOnce({ draftId: null })
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    // An HTTP-level "it didn't reject" is not proof a specific draft exists
    // — product invariant #1 requires an identity we can point back to.
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('ZOHO_DRAFT_ID_MISSING')
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('uncertain')
  })
})

describe('draft_in_inbox — deterministic provider rejection (CAY-139 test 4/5: artifact preserved, no send)', () => {
  it('classifies an explicit non-auth, non-rate-limit HTTP status as a deterministic FAILED_PERMANENT rejection', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 400, code 400): malformed payload')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error_code).toBe('ZOHO_DRAFT_REJECTED')
    expect(result.retryable).toBe(false)

    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('failed')
  })

  it('never sends the customer anything on a deterministic rejection — result carries sent:false, no send-shaped data', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 400, code 400): malformed payload')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect((result.data as { sent: boolean }).sent).toBe(false)
  })
})

describe('draft_in_inbox — ambiguous/uncertain outcome (CAY-139 test 5/6: no blind duplicate, honest uncertainty)', () => {
  it('classifies a network/timeout error with no HTTP status as NEEDS_HUMAN/uncertain, not FAILED_RETRYABLE', async () => {
    nextDraftOutcome = new Error('fetch failed: ETIMEDOUT')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.ok).toBe(false)
    // NOT retryable — the orchestrator only auto-retries FAILED_RETRYABLE,
    // and a blind retry here risks a real duplicate draft.
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('ZOHO_DRAFT_CREATION_UNCERTAIN')
  })

  it('marks active work "uncertain", never "failed" — the provider may have created it', async () => {
    nextDraftOutcome = new Error('socket hang up')
    await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('uncertain')
    expect(active.status).not.toBe('failed')
    expect(active.status).not.toBe('completed')
  })

  it('treats an explicit 5xx as uncertain too, NOT a deterministic rejection — a server error can fire after the write already persisted', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 500, code 500): internal server error')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.status).toBe('NEEDS_HUMAN')
    expect(result.error_code).toBe('ZOHO_DRAFT_CREATION_UNCERTAIN')
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('uncertain')
  })

  it('the orchestrator never auto-retries a NEEDS_HUMAN classification (single attempt for an ambiguous outcome)', async () => {
    // This is the actual duplicate-prevention guarantee: runToolWithRecovery
    // (orchestrator.ts) only retries FAILED_RETRYABLE. Import it directly to
    // prove the ambiguous branch's status can't trigger a second call.
    const { runToolWithRecovery } = await import('../../orchestrator')
    nextDraftOutcome = new Error('network timeout')
    const { attempts } = await runToolWithRecovery(draftInInbox, { conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork, {
      mode: 'back-office',
    })
    expect(attempts).toBe(1)
    expect(createZohoReplyDraftMock).toHaveBeenCalledTimes(1)
  })
})

describe('draft_in_inbox — verification gate blocked (CAY-139 root cause: never mistaken for a live outage)', () => {
  it('returns a deterministic, non-retryable FAILED_PERMANENT with its own error_code, distinct from every live-provider failure', async () => {
    checkZohoDraftGateMock.mockReturnValue({
      allowed: false,
      reason: "I can't write drafts into your inbox yet — that path hasn't been safety-checked on this account.",
    })
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error_code).toBe('ZOHO_DRAFT_MODE_NOT_VERIFIED')
    expect(result.retryable).toBe(false)
    // Never even reaches the provider — this is a pre-flight gate, not a
    // live call that failed.
    expect(createZohoReplyDraftMock).not.toHaveBeenCalled()
  })

  it('preserves active work as failed/editable rather than leaving it stuck in whatever state preceded it', async () => {
    checkZohoDraftGateMock.mockReturnValue({ allowed: false, reason: 'not verified yet' })
    await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, ctxWithActiveWork)
    const active = (activeWorkUpdates[0].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('failed')
  })
})

describe('draft_in_inbox — revised draft after a prior failed attempt (CAY-139 test 7)', () => {
  it('a later successful call carries the LATEST body, not a stale earlier one', async () => {
    nextDraftOutcome = new Error('Zoho Mail API draft error (HTTP 400, code 400): rejected')
    await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'first attempt text' }, ctxWithActiveWork)
    expect((activeWorkUpdates[0].intent as { active_work: { artifact: string } }).active_work.artifact).toBe(
      'first attempt text'
    )

    nextDraftOutcome = 'success'
    const second = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'revised final text' }, ctxWithActiveWork)
    expect(second.ok).toBe(true)
    const active = (activeWorkUpdates[1].intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('completed')
    expect(active.artifact).toBe('revised final text')
  })
})

describe('draft_in_inbox — active-work identity safety (CAY-139 test 8)', () => {
  it('cannot mutate active work when ctx.activeWork does not match the persisted row (stale/mismatched identity)', async () => {
    const mismatchedCtx: ToolContext = {
      ...baseCtx,
      activeWork: {
        sourceMessageId: 'jeff-work',
        entityRef: 'someone-else@example.com', // does not match activeWorkRow's entityRef
        operation: 'customer_reply_draft',
      },
    }
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: 'x' }, mismatchedCtx)
    // The draft itself still succeeds (updateActiveWork failing to match is
    // a silent no-op, not a tool failure) — but the stale row must NOT have
    // been overwritten.
    expect(result.ok).toBe(true)
    expect(activeWorkUpdates).toHaveLength(0)
  })
})
