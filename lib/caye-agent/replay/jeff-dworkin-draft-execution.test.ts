import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../tools/types'

vi.mock('server-only', () => ({}))

/**
 * jeff-dworkin-draft-execution.test.ts
 *
 * REGRESSION FIXTURE — CAY-139 (2026-08-26)
 *
 * Live Bimini validation after PR #138 reproduced this exact path: Mrs. Max
 * asked Caye to draft a reply to Jeff Dworkin, revised the draft across
 * several turns (active-work continuity worked correctly — see
 * lib/whatsapp/active-work.test.ts's own "Jeff Dworkin regression" describe
 * block, same customer, same scenario), then said "draft that version in
 * the inbox, don't send it." The external draft save repeatedly failed, and
 * Caye reported it as "the staging system is down" / "backend issue" /
 * implied TropiTech should be notified — none of which any tool result that
 * turn actually said. This file replays the full pipeline end to end
 * (active-work seed → revision → draft_in_inbox execution → guidance →
 * the action-claim-guard backstop) without a live model call, since the
 * defect this ticket fixes is in DETERMINISTIC code (classification,
 * guidance text, the text-level backstop), not in prompt-following — see
 * fixtures.test.ts's header comment for why live-model verification is
 * intentionally a separate, manual concern from this deterministic layer.
 *
 * Sanitized: no real customer PII beyond the first name already used in the
 * incident report and lib/whatsapp/active-work.test.ts's existing fixture.
 */

vi.mock('../tools/write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
}))

const checkZohoDraftGateMock = vi.fn((): { allowed: boolean; reason?: string } => ({ allowed: true, reason: undefined }))
vi.mock('@/lib/zoho-draft-gate', () => ({
  ZOHO_DRAFT_VERIFIED_KEY: 'zoho_draft_mode_verified',
  checkZohoDraftGate: () => checkZohoDraftGateMock(),
}))

let nextOutcome: 'success' | Error = 'success'
const createZohoReplyDraftMock = vi.fn(async () => {
  if (nextOutcome instanceof Error) throw nextOutcome
  return { draftId: 'zoho_draft_jeff_1' as string | null }
})
vi.mock('@/lib/email-ai', () => ({
  createZohoReplyDraft: (...a: unknown[]) => (createZohoReplyDraftMock as (...a: unknown[]) => Promise<unknown>)(...a),
}))

const conversationRow = {
  customer_id: 'cust_jeff',
  customer_name: 'Jeff Dworkin',
  channel_type: 'email',
  channel_conversation_id: 'chan_jeff',
  metadata: { subject: 'Tour Booking: Jeff Dworkin' },
}

let activeWorkRow: { id: string; intent: Record<string, unknown> } | null = null
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
      if (activeWorkRow) activeWorkRow = { ...activeWorkRow, intent: value.intent as Record<string, unknown> }
      return { eq: async () => ({ data: null }) }
    },
  }
  return builder
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'platform_settings') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: 'verified' } }) }) }) }
      }
      if (table === 'unified_conversations') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conversationRow }) }) }) }
      }
      if (table === 'caye_operator_messages') return operatorMessagesTable()
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

const { seedActiveWork, intentWithActiveWork } = await import('@/lib/whatsapp/active-work')
const { draftInInbox } = await import('../tools/write-high/draft-in-inbox')
const { guidanceFor } = await import('../orchestrator')
const { enforceActionGrounding } = await import('../action-claim-guard')

const ctx: ToolContext = {
  workspaceId: 'ws_bimini',
  callerRole: 'owner',
  requestId: 'req_jeff_1',
  operatorId: 7,
  activeWork: { sourceMessageId: 'jeff-work', entityRef: 'jeffd@jldhomes.com', operation: 'customer_reply_draft' },
}

const FIRST_DRAFT = 'Draft a thank you to jeffd@jldhomes.com: Hi Jeff, thanks so much for the kind words!'
const REVISED_BODY =
  "Hi Jeff, thank you for the wonderful trip! James Edden made the day memorable — we'll pass along your thanks."

beforeEach(() => {
  nextOutcome = 'success'
  checkZohoDraftGateMock.mockReturnValue({ allowed: true, reason: undefined })
  const seeded = seedActiveWork(FIRST_DRAFT, { kind: 'edit', instruction: FIRST_DRAFT })!
  activeWorkRow = {
    id: 'jeff-work',
    intent: intentWithActiveWork({ kind: 'edit', instruction: FIRST_DRAFT }, { ...seeded, status: 'ready' }),
  }
  activeWorkUpdates.length = 0
  createZohoReplyDraftMock.mockClear()
})

describe('Jeff Dworkin — active work survives revision up to the "draft in the inbox" turn', () => {
  it('the seeded active work is the exact draft continuity fixture already covered in active-work.test.ts', () => {
    const work = seedActiveWork(FIRST_DRAFT, { kind: 'edit', instruction: FIRST_DRAFT })
    expect(work).toMatchObject({ entityRef: 'jeffd@jldhomes.com', operation: 'customer_reply_draft' })
  })
})

describe('Jeff Dworkin — "draft that version in the inbox, don\'t send it" — success path', () => {
  it('creates exactly one provider draft, persists the exact latest artifact, no send occurs', async () => {
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: REVISED_BODY }, ctx)
    expect(result.ok).toBe(true)
    expect((result.data as { draft_id: string }).draft_id).toBe('zoho_draft_jeff_1')
    expect((result.data as { sent: boolean }).sent).toBe(false)
    expect(createZohoReplyDraftMock).toHaveBeenCalledTimes(1)

    const active = (activeWorkUpdates.at(-1)!.intent as { active_work: Record<string, unknown> }).active_work
    expect(active.status).toBe('completed')
    expect(active.artifact).toBe(REVISED_BODY)
  })
})

describe('Jeff Dworkin — every failure class produces evidence-backed guidance and no send (CAY-139 test 9)', () => {
  const cases: Array<{ label: string; setUp: () => void; expectStatus: string; expectCode: string; expectActiveWork: string }> = [
    {
      label: 'rate limited',
      setUp: () => { nextOutcome = new Error('Zoho Mail API draft error (HTTP 429, code 429): {}') },
      expectStatus: 'FAILED_RETRYABLE',
      expectCode: 'ZOHO_DRAFT_RATE_LIMITED',
      expectActiveWork: 'failed',
    },
    {
      label: 'auth blocked',
      setUp: () => { nextOutcome = new Error('Zoho Mail API draft error (HTTP 401, code 401): unauthorized') },
      expectStatus: 'NEEDS_HUMAN',
      expectCode: 'ZOHO_DRAFT_AUTH_REQUIRED',
      expectActiveWork: 'failed',
    },
    {
      label: 'deterministic rejection',
      setUp: () => { nextOutcome = new Error('Zoho Mail API draft error (HTTP 400, code 400): malformed payload') },
      expectStatus: 'FAILED_PERMANENT',
      expectCode: 'ZOHO_DRAFT_REJECTED',
      expectActiveWork: 'failed',
    },
    {
      label: 'ambiguous/timeout',
      setUp: () => { nextOutcome = new Error('fetch failed: ETIMEDOUT') },
      expectStatus: 'NEEDS_HUMAN',
      expectCode: 'ZOHO_DRAFT_CREATION_UNCERTAIN',
      expectActiveWork: 'uncertain',
    },
    {
      label: 'verification gate not yet run',
      setUp: () => {
        checkZohoDraftGateMock.mockReturnValue({
          allowed: false,
          reason: "I can't write drafts into your inbox yet — that path hasn't been safety-checked on this account.",
        })
      },
      expectStatus: 'FAILED_PERMANENT',
      expectCode: 'ZOHO_DRAFT_MODE_NOT_VERIFIED',
      expectActiveWork: 'failed',
    },
  ]

  for (const c of cases) {
    it(`${c.label}: classified correctly, artifact preserved, guidance forbids "system down"/"backend"/fake escalation, no send`, async () => {
      c.setUp()
      const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: REVISED_BODY }, ctx)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(c.expectStatus)
      expect(result.error_code).toBe(c.expectCode)
      // Never a send, under any failure path.
      const data = result.data as { sent?: boolean } | undefined
      if (data && 'sent' in data) expect(data.sent).toBe(false)

      const active = (activeWorkUpdates.at(-1)!.intent as { active_work: Record<string, unknown> }).active_work
      expect(active.status).toBe(c.expectActiveWork)
      // The artifact preserved is the exact latest revision, not a stale one.
      expect(active.artifact).toBe(REVISED_BODY)

      const guidance = guidanceFor(result.status, false, 'draft_in_inbox', result.error_code)!
      expect(guidance).toMatch(/never describe this as a system outage/i)
      expect(guidance).toMatch(/never say anyone was notified or flagged/i)
    })
  }
})

describe('Jeff Dworkin — deterministic provider rejection end-to-end (follow-up: ZOHO_DRAFT_REJECTED must read as a definite, known failure)', () => {
  it('a real 400 rejection from Zoho produces guidance that is definite, not an "uncertain" hedge, and is not the generic fallback', async () => {
    nextOutcome = new Error('Zoho Mail API draft error (HTTP 422, code 422): unprocessable entity')
    const result = await draftInInbox.execute({ conversation_id: 'conv_jeff', body: REVISED_BODY }, ctx)

    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error_code).toBe('ZOHO_DRAFT_REJECTED')

    const guidance = guidanceFor(result.status, false, 'draft_in_inbox', result.error_code)!
    // Definite, known-failure semantics.
    expect(guidance).toMatch(/rejected/i)
    expect(guidance).toMatch(/nothing was created/i)
    expect(guidance).toMatch(/preserve the completed draft text/i)
    expect(guidance).toMatch(/do NOT retry blindly/i)
    expect(guidance).toMatch(/do NOT offer to send it instead/i)
    // Must never borrow the ambiguous-outcome case's vocabulary.
    expect(guidance).not.toMatch(/uncertain/i)
    expect(guidance).not.toMatch(/not sure whether/i)
    // Must not be the generic default/fallback text (proves the case is
    // actually wired up and not silently falling through).
    const fallback = guidanceFor('FAILED_PERMANENT', false, 'draft_in_inbox', 'SOME_UNRECOGNISED_CODE')!
    expect(guidance).not.toBe(fallback)
    expect(guidance).not.toMatch(/blocked or uncertain/i)
    // Must read distinctly from the genuinely ambiguous case for the same tool.
    const ambiguousGuidance = guidanceFor('NEEDS_HUMAN', false, 'draft_in_inbox', 'ZOHO_DRAFT_CREATION_UNCERTAIN')!
    expect(guidance).not.toBe(ambiguousGuidance)
  })
})

describe('Jeff Dworkin — the actual incident sentence can no longer reach the operator (CAY-139 test 9, literal reconstruction)', () => {
  it('strips the exact reported phrasing even when a real draft_in_inbox call failed this turn', () => {
    // Reconstructed from the issue's own description of the incident, not a
    // literal customer transcript (no such transcript exists in this repo).
    const incidentText =
      "I tried a few more times but it looks like the staging system is down right now, or there might be a " +
      "backend issue on our end — I've kept your draft here. This is probably worth flagging to the TropiTech team."
    const { text, violations } = enforceActionGrounding(incidentText, [{ name: 'draft_in_inbox', ok: false }])
    // Both the invented root-cause claim AND the invented escalation claim
    // are caught, by their own separate rules (CAY-140 review split).
    expect(violations.map((v) => v.category)).toContain('unsupported-infrastructure-claim')
    expect(violations.map((v) => v.category)).toContain('unsupported-platform-escalation-claim')
    expect(text).not.toMatch(/staging system is down/i)
    expect(text).not.toMatch(/backend issue/i)
    expect(text).not.toMatch(/flagging to the TropiTech team/i)
  })

  it('a TRUE "I notified the team" claim from the same incident thread, backed by a real send_operator_message call, survives untouched (CAY-140 regression)', () => {
    // Guards against re-introducing the CAY-140 regression in this exact
    // Jeff Dworkin context: a legitimate operator-notification claim must
    // never be swept up by the draft-failure-adjacent guards above.
    const replyText = "I couldn't save the draft to the inbox, so I let the team know to check on it."
    const executed = [
      { name: 'draft_in_inbox', ok: false },
      { name: 'send_operator_message', ok: true },
    ]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })
})
