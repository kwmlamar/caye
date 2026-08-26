import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

interface ClaimRow {
  claim_id: string
  generation: number
  acquired: boolean
  blocked_by: string | null
}

interface ValidateRow {
  valid: boolean
  reason: string | null
}

describe('conversation execution coordination migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create table public.customers (id uuid primary key default gen_random_uuid());
      create table public.unified_conversations (id uuid primary key default gen_random_uuid());
      create table public.unified_messages (
        id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.unified_conversations(id),
        sender_type text not null default 'customer', is_internal boolean not null default false, sent_at timestamptz not null default now()
      );
      create table public.caye_pending_actions (
        id uuid primary key default gen_random_uuid(), execution_claim_id uuid, executed_at timestamptz, cancelled_at timestamptz, expires_at timestamptz not null default now()
      );
      create role anon; create role authenticated; create role service_role;
    `)
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260825_conversation_execution_coordination.sql'), 'utf8')
    await db.exec(sql)
  })

  afterAll(async () => { await db.close() })

  // ── Fixture helpers ──────────────────────────────────────────────────────
  async function makeWorkspaceAndConversation() {
    const { rows: ws } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const { rows: conv } = await db.query<{ id: string }>('insert into public.unified_conversations default values returning id')
    return { workspaceId: ws[0].id, conversationId: conv[0].id }
  }

  async function makeCustomerMessage(conversationId: string, sentAt?: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.unified_messages (conversation_id, sender_type, is_internal, sent_at) values ($1, 'customer', false, coalesce($2, now())) returning id`,
      [conversationId, sentAt ?? null]
    )
    return rows[0].id
  }

  async function claim(args: {
    workspaceId: string
    conversationId: string
    holder: string
    idempotencyKey: string
    triggeringMessageId?: string | null
    leaseSeconds?: number
  }): Promise<ClaimRow> {
    const { rows } = await db.query<ClaimRow>(
      `select * from claim_conversation_execution(
        p_workspace_id => $1, p_conversation_id => $2, p_holder_kind => $3, p_idempotency_key => $4,
        p_triggering_message_id => $5, p_reason => null, p_lease_seconds => $6
      )`,
      [args.workspaceId, args.conversationId, args.holder, args.idempotencyKey, args.triggeringMessageId ?? null, args.leaseSeconds ?? 900]
    )
    return rows[0]
  }

  async function validate(claimId: string, triggeringMessageId?: string | null): Promise<ValidateRow> {
    const { rows } = await db.query<ValidateRow>(
      `select * from validate_conversation_execution(p_claim_id => $1, p_triggering_message_id => $2)`,
      [claimId, triggeringMessageId ?? null]
    )
    return rows[0]
  }

  async function complete(claimId: string, outboundMessageId?: string | null) {
    await db.query(`select complete_conversation_execution(p_claim_id => $1, p_outbound_message_id => $2)`, [claimId, outboundMessageId ?? null])
  }

  async function release(claimId: string) {
    await db.query(`select release_conversation_execution(p_claim_id => $1)`, [claimId])
  }

  async function abandon(claimId: string) {
    await db.query(`select abandon_conversation_execution_response(p_claim_id => $1)`, [claimId])
  }

  async function markAmbiguous(claimId: string) {
    await db.query(`select mark_conversation_execution_ambiguous(p_claim_id => $1)`, [claimId])
  }

  async function claimStatus(claimId: string) {
    const { rows } = await db.query<{ completed_at: string | null; released_at: string | null; superseded_at: string | null }>(
      `select completed_at, released_at, superseded_at from conversation_execution_claims where id = $1`,
      [claimId]
    )
    return rows[0]
  }

  it('permits one active owner but preserves the completed audit history', async () => {
    const { rows: ws } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const { rows: conv } = await db.query<{ id: string }>('insert into public.unified_conversations default values returning id')
    const insert = `insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, expires_at) values ($1, $2, 'autonomous_frontdesk', $3, now() + interval '15 minutes') returning id`
    const first = await db.query<{ id: string }>(insert, [ws[0].id, conv[0].id, 'inbound-a'])
    await expect(db.query(insert, [ws[0].id, conv[0].id, 'inbound-b'])).rejects.toMatchObject({ code: '23505' })
    await db.query('update public.conversation_execution_claims set completed_at = now() where id = $1', [first.rows[0].id])
    await expect(db.query(insert, [ws[0].id, conv[0].id, 'inbound-b'])).resolves.toBeDefined()
  })

  it('enforces one response execution per inbound customer turn', async () => {
    const { rows: ws } = await db.query<{ id: string }>('insert into public.customers default values returning id')
    const { rows: conv } = await db.query<{ id: string }>('insert into public.unified_conversations default values returning id')
    const { rows: msg } = await db.query<{ id: string }>('insert into public.unified_messages (conversation_id) values ($1) returning id', [conv[0].id])
    const { rows: claimRow } = await db.query<{ id: string }>(`insert into public.conversation_execution_claims (workspace_id, conversation_id, holder_kind, idempotency_key, expires_at) values ($1, $2, 'autonomous_frontdesk', 'same-turn', now() + interval '15 minutes') returning id`, [ws[0].id, conv[0].id])
    const insert = `insert into public.conversation_response_executions (workspace_id, conversation_id, inbound_message_id, claim_id, disposition) values ($1, $2, $3, $4, 'reply')`
    await db.query(insert, [ws[0].id, conv[0].id, msg[0].id, claimRow[0].id])
    await expect(db.query(insert, [ws[0].id, conv[0].id, msg[0].id, claimRow[0].id])).rejects.toMatchObject({ code: '23505' })
  })

  // ── #1: operator supersession ──────────────────────────────────────────
  describe('operator supersession (Autumn scenario)', () => {
    it('an operator claim supersedes an active autonomous claim, and the stale autonomous claim fails validation before it can send', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()

      const autonomous = await claim({
        workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:msg-1',
      })
      expect(autonomous.acquired).toBe(true)

      // Mrs. Max gives Caye a newer explicit instruction on the same thread.
      const operator = await claim({
        workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: 'operator-draft:pending-1',
      })
      expect(operator.acquired).toBe(true)
      expect(operator.claim_id).not.toBe(autonomous.claim_id)

      // The autonomous worker's claim is now superseded.
      const autonomousStatus = await claimStatus(autonomous.claim_id)
      expect(autonomousStatus.superseded_at).not.toBeNull()

      // Its pre-send revalidation (the mandatory last gate) must fail closed.
      const staleValidate = await validate(autonomous.claim_id)
      expect(staleValidate.valid).toBe(false)
      expect(staleValidate.reason).toBe('claim_inactive')

      // Only the operator-directed claim may proceed to send.
      const operatorValidate = await validate(operator.claim_id)
      expect(operatorValidate.valid).toBe(true)
    })

    it('reverse: an active operator claim is NOT superseded by an autonomous worker — it yields instead', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()

      const operator = await claim({
        workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: 'operator-draft:pending-2',
      })
      expect(operator.acquired).toBe(true)

      const autonomous = await claim({
        workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:msg-2',
      })
      expect(autonomous.acquired).toBe(false)
      expect(autonomous.blocked_by).toBe('operator_caye')

      // The operator's claim must be untouched — still valid, not superseded.
      const operatorStatus = await claimStatus(operator.claim_id)
      expect(operatorStatus.superseded_at).toBeNull()
      const operatorValidate = await validate(operator.claim_id)
      expect(operatorValidate.valid).toBe(true)
    })

    it('same-tier claims never steal from each other — a second autonomous/scheduled claim is blocked, not superseded', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()

      const first = await claim({
        workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: 'sched-a',
      })
      expect(first.acquired).toBe(true)

      const second = await claim({
        workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:msg-3',
      })
      expect(second.acquired).toBe(false)
      expect(second.blocked_by).toBe('scheduled_system')

      const firstStatus = await claimStatus(first.claim_id)
      expect(firstStatus.superseded_at).toBeNull()
    })
  })

  // ── #2: response-reservation failure/retry semantics ───────────────────
  describe('response-reservation lifecycle on dispatch failure', () => {
    it('A: a definite pre-send failure abandons the reservation, so a later claim can answer the same inbound turn', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const inboundId = await makeCustomerMessage(conversationId)

      const claimA = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:a', triggeringMessageId: inboundId })
      const validateA = await validate(claimA.claim_id, inboundId)
      expect(validateA.valid).toBe(true)

      // Provider definitely failed before any send was attempted.
      await abandon(claimA.claim_id)
      const statusA = await claimStatus(claimA.claim_id)
      expect(statusA.released_at).not.toBeNull()

      const claimB = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:a-retry', triggeringMessageId: inboundId })
      expect(claimB.acquired).toBe(true)
      const validateB = await validate(claimB.claim_id, inboundId)
      expect(validateB.valid).toBe(true)
      await complete(claimB.claim_id)
      const statusB = await claimStatus(claimB.claim_id)
      expect(statusB.completed_at).not.toBeNull()
    })

    it('B: an ambiguous outcome (provider may have sent) blocks every later claim from answering the same inbound turn', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const inboundId = await makeCustomerMessage(conversationId)

      const claimA = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:b', triggeringMessageId: inboundId })
      await validate(claimA.claim_id, inboundId)

      // Provider call itself threw — outcome unknown. Must fail closed.
      await markAmbiguous(claimA.claim_id)
      const statusA = await claimStatus(claimA.claim_id)
      expect(statusA.released_at).not.toBeNull()
      expect(statusA.completed_at).toBeNull()

      const claimB = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:b-retry', triggeringMessageId: inboundId })
      expect(claimB.acquired).toBe(true)
      const validateB = await validate(claimB.claim_id, inboundId)
      expect(validateB.valid).toBe(false)
      expect(validateB.reason).toBe('inbound_reserved_by_other_execution')
    })

    it('B2: a definitely-sent-but-unpersisted outcome completes the reservation outright — never retryable', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const inboundId = await makeCustomerMessage(conversationId)

      const claimA = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:b2', triggeringMessageId: inboundId })
      await validate(claimA.claim_id, inboundId)

      // Provider call returned successfully; only our own receipt bookkeeping
      // failed afterward. This is the ONE case we're certain about — treat
      // exactly like a normal completed send.
      await complete(claimA.claim_id)

      const claimB = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:b2-retry', triggeringMessageId: inboundId })
      expect(claimB.acquired).toBe(true)
      const validateB = await validate(claimB.claim_id, inboundId)
      expect(validateB.valid).toBe(false)
      expect(validateB.reason).toBe('already_answered')
    })

    it('C: a superseding claim racing the same inbound turn cannot answer it twice — the earlier reservation still wins', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const inboundId = await makeCustomerMessage(conversationId)

      // Claim A (autonomous) gets far enough to reserve the inbound turn —
      // but has NOT yet dispatched or resolved the reservation — when
      // claim B (operator) supersedes it. Only one active claim can ever
      // exist per conversation (conversation_execution_one_active_claim),
      // so "simultaneous" here means: A's reservation is still live and
      // unresolved at the moment B tries to answer the SAME inbound turn.
      const claimA = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:c-a', triggeringMessageId: inboundId })
      const validateA = await validate(claimA.claim_id, inboundId)
      expect(validateA.valid).toBe(true)

      const claimB = await claim({ workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: 'operator-draft:c-b' })
      expect(claimB.acquired).toBe(true)
      const statusA = await claimStatus(claimA.claim_id)
      expect(statusA.superseded_at).not.toBeNull()

      // B tries to answer the SAME inbound turn A already reserved. A's
      // outcome is still unknown (neither completed nor abandoned) — B must
      // NOT be allowed to answer it too.
      const validateB = await validate(claimB.claim_id, inboundId)
      expect(validateB.valid).toBe(false)
      expect(validateB.reason).toBe('inbound_reserved_by_other_execution')
    })
  })

  // ── #3: idempotency-key lifecycle ──────────────────────────────────────
  describe('idempotency-key lifecycle', () => {
    it('retry after a definite pre-send failure (released) mints a new generation under the same key without violating uniqueness', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const key = 'payment-confirmation:booking-1'

      const first = await claim({ workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: key })
      await release(first.claim_id)

      const second = await claim({ workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: key })
      expect(second.acquired).toBe(true)
      expect(second.claim_id).not.toBe(first.claim_id)
      expect(second.generation).toBeGreaterThan(first.generation)
    })

    it('retry after a completed execution mints a new generation under the same key without violating uniqueness', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const key = 'operator-draft:pending-completed'

      const first = await claim({ workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: key })
      await complete(first.claim_id)

      // A later, genuinely separate piece of work reusing the same
      // (operator, conversation)-shaped key must not be permanently blocked
      // by the FIRST successful send.
      const second = await claim({ workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: key })
      expect(second.acquired).toBe(true)
      expect(second.claim_id).not.toBe(first.claim_id)
      const secondValidate = await validate(second.claim_id)
      expect(secondValidate.valid).toBe(true)
    })

    it('retry after a superseded execution mints a new generation and correctly re-arbitrates against whatever is active now', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const key = 'frontdesk:msg-superseded'

      const autonomous = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: key })
      const operator = await claim({ workspaceId, conversationId, holder: 'operator_caye', idempotencyKey: 'operator-draft:pending-3' })
      expect(operator.acquired).toBe(true)
      const autonomousStatus = await claimStatus(autonomous.claim_id)
      expect(autonomousStatus.superseded_at).not.toBeNull()

      // A retry under the ORIGINAL (now-superseded) key must not error, but
      // it re-arbitrates against the operator's still-active claim and
      // correctly loses (same-or-lower tier, active, no pending).
      const retry = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: key })
      expect(retry.acquired).toBe(false)
      expect(retry.blocked_by).toBe('operator_caye')
    })

    it('a stable scheduled-job idempotency key reused while still active returns the SAME claim (no duplicate row)', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const key = 'tour-reminder:day_before:booking-9'

      const first = await claim({ workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: key })
      const second = await claim({ workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: key })
      expect(second.acquired).toBe(true)
      expect(second.claim_id).toBe(first.claim_id)
      expect(second.generation).toBe(first.generation)

      const { rows: count } = await db.query<{ count: string }>(
        `select count(*)::text from conversation_execution_claims where idempotency_key = $1`,
        [key]
      )
      expect(count[0].count).toBe('1')
    })
  })

  // ── #4/#5: claim terminal-state invariant ──────────────────────────────
  describe('every acquired claim reaches a terminal state', () => {
    it('a claim that is never validated, then explicitly released, ends released — not stuck active', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const c = await claim({ workspaceId, conversationId, holder: 'scheduled_system', idempotencyKey: 'tour-reminder:day_of:booking-2' })
      await release(c.claim_id)
      const status = await claimStatus(c.claim_id)
      expect(status.released_at).not.toBeNull()
      expect(status.completed_at).toBeNull()
      expect(status.superseded_at).toBeNull()
    })

    it('newer customer message invalidates a claim mid-flight, independent of supersession', async () => {
      const { workspaceId, conversationId } = await makeWorkspaceAndConversation()
      const firstMsg = await makeCustomerMessage(conversationId, '2026-08-25T09:00:00Z')
      const c = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:sonja-1', triggeringMessageId: firstMsg })
      const okBefore = await validate(c.claim_id, firstMsg)
      expect(okBefore.valid).toBe(true)

      // Customer sends a newer message before dispatch — no stale reply.
      await makeCustomerMessage(conversationId, '2026-08-25T10:00:00Z')
      const c2 = await claim({ workspaceId, conversationId, holder: 'autonomous_frontdesk', idempotencyKey: 'frontdesk:sonja-2', triggeringMessageId: firstMsg })
      const stale = await validate(c2.claim_id, firstMsg)
      expect(stale.valid).toBe(false)
      expect(stale.reason).toBe('newer_customer_message')
    })
  })
})
