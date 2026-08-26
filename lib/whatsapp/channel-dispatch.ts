import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendMetaMessage } from '@/lib/meta-reply'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendZohoReply, sendZohoEmail } from '@/lib/email-ai'
import type { VoiceProfile } from '@/lib/voice-profile'
import { ensureTagline } from '@/lib/voice-profile'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { recordSalesLifecycleEvent } from '@/lib/sales/lifecycle'

/**
 * Send `text` to the guest on the conversation's native channel and persist
 * the outbound message. Used by the `send` and `edit` action handlers to
 * ship the operator-approved (or operator-revised) draft.
 *
 * Mirrors the dispatch switch in app/api/messages/send/route.ts, but skips
 * the auth checks (caller already validated the operator's WhatsApp identity).
 */

export interface DispatchResult {
  success: true
  channelType: string
  messageId?: string
  /** True when this call found and returned an ALREADY-SENT result via
   *  idempotencyKey rather than sending again. See idempotencyKey's doc
   *  comment below. Undefined on every call that didn't pass one. */
  deduped?: boolean
}

/**
 * Thrown instead of a plain Error whenever the caller cannot safely assume
 * "nothing was sent." Conversation-execution coordination (lib/conversation-
 * execution.ts) uses `definitelySent` to decide whether a failed dispatch is
 * safe to retry:
 *
 * - `definitelySent: true` — the provider call itself returned successfully
 *   (the customer-facing side effect happened) and ONLY our own bookkeeping
 *   (the unified_messages insert or the conversation preview update)
 *   afterward failed. The send is certain; treat this like a completed send,
 *   never like a retryable failure.
 * - `definitelySent: false` — the provider call itself threw (network
 *   error, timeout, non-2xx, etc). Whether the provider actually received
 *   and will act on the message before erroring back to us is NOT knowable
 *   from here. Must fail closed: not safe to complete, not safe to retry.
 *
 * Plain `Error`s thrown by this function (conversation not found, empty
 * body, unsupported channel, the idempotency pre-check) all happen BEFORE
 * any provider call is attempted — those are the only failures safe to
 * treat as "definitely did not send."
 */
export class DispatchAmbiguousError extends Error {
  readonly definitelySent: boolean
  constructor(message: string, definitelySent: boolean) {
    super(message)
    this.name = 'DispatchAmbiguousError'
    this.definitelySent = definitelySent
  }
}

/**
 * 'caye-frontdesk-agent' (2026-08-16, Phase 3) — a customer reply the
 * converged front-desk agent composed and sent AUTONOMOUSLY (evidence
 * sufficient, no operator in the loop), distinct from the other two labels
 * which both mean "an operator relayed/authorized this." Not currently
 * produced by any production call path — see
 * lib/caye-agent/tools/write-high/send-customer-reply.ts.
 */
export type OperatorReplySender = 'caye-operator-wa' | 'caye-dashboard' | 'caye-frontdesk-agent' | 'caye-outreach-autonomous'

export async function dispatchOperatorReply(
  conversationId: string,
  text: string,
  senderLabel: OperatorReplySender = 'caye-operator-wa',
  /**
   * 2026-08-16, final pre-canary closure. Optional caller-supplied key
   * identifying "the reply to inbound message X" — the SAME identity the
   * WhatsApp webhook already uses for its own inbound dedup
   * (`channel_message_id`, app/api/webhooks/whatsapp/route.ts). When
   * provided, a webhook-level retry of the entire inbound message (not a
   * same-turn/same-request retry — those are already covered by
   * `gateHighRisk`/`MAX_ATTEMPTS.high = 1`) collapses onto the ONE real
   * send: if a `unified_messages` row already carries this key in its
   * metadata for this conversation, that row's result is returned as-is
   * and NO channel API call is made a second time. Every existing caller
   * omits this and gets byte-identical behavior to before — this is
   * additive, not a change to back-office's `send_reply`.
   */
  idempotencyKey?: string
): Promise<DispatchResult> {
  const supabase = createServiceClient()

  if (idempotencyKey) {
    const { data: existingSend } = await supabase
      .from('unified_messages')
      .select('channel_message_id, metadata')
      .eq('conversation_id', conversationId)
      .contains('metadata', { idempotency_key: idempotencyKey })
      .maybeSingle()
    if (existingSend) {
      const meta = (existingSend.metadata ?? {}) as Record<string, unknown>
      return {
        success: true,
        channelType: typeof meta.idempotency_channel === 'string' ? meta.idempotency_channel : 'unknown',
        messageId: existingSend.channel_message_id ?? undefined,
        deduped: true,
      }
    }
  }

  const { data: conv, error } = await supabase
    .from('unified_conversations')
    .select(
      `
      id, channel_type, customer_id, channel_conversation_id, metadata,
      connected_account:connected_accounts(
        id, user_id, channel_type, channel_account_id, access_token, metadata
      )
    `
    )
    .eq('id', conversationId)
    .single()

  if (error || !conv) {
    throw new Error(`conversation ${conversationId} not found: ${error?.message ?? ''}`)
  }

  const account = Array.isArray(conv.connected_account)
    ? conv.connected_account[0]
    : conv.connected_account
  if (!account) throw new Error('connected_account missing on conversation')

  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty reply')
  let outboundBody = trimmed
  const meta = (conv.metadata ?? {}) as Record<string, unknown>
  // Zoho's own id for the message we're about to send. Persisted below so a
  // later message on this thread (typically a follow-up nudge to a lead who
  // never replied) can reply against it and thread correctly — see
  // findReplyTargetZohoMessageId in lib/email-ai.ts.
  let zohoMessageId: string | null = null

  if (!['messenger', 'instagram', 'whatsapp', 'email'].includes(conv.channel_type)) {
    throw new Error(`unsupported channel: ${conv.channel_type}`)
  }

  // Everything below this line can perform the real customer-facing side
  // effect. Any exception from here on is wrapped as DispatchAmbiguousError
  // so a caller can never mistake "provider call threw" for "definitely
  // nothing was sent" — see the class doc comment.
  try {
    switch (conv.channel_type) {
      case 'messenger':
      case 'instagram':
        await sendMetaMessage(conv.customer_id, trimmed, account.access_token)
        break
      case 'whatsapp':
        await sendWhatsAppMessage(
          conv.customer_id,
          trimmed,
          account.channel_account_id,
          account.access_token
        )
        break
      case 'email': {
        if (meta.hold_kind === 'outreach_first_touch') {
          // First-touch cold outreach — no real prior thread to reply into and
          // no inbound subject to inherit, so send a clean standalone email
          // with the subject the draft was created with (mirrors
          // app/api/messages/send/route.ts's outreach branch). No "Re:"
          // prefix and no tagline — those are reply-thread conventions that
          // don't apply to a cold open.
          const subject = (meta.subject as string) || 'Quick question'
          const sent = await sendZohoEmail(conv.customer_id, subject, trimmed, account.user_id)
          zohoMessageId = sent.messageId
          break
        }
        const subj = (meta.subject as string) || '(no subject)'
        const replySubject = subj.startsWith('Re:') ? subj : `Re: ${subj}`
        // The body here is Caye-composed (operator approved/revised the draft),
        // so the outbound-email tagline guarantee applies just like the
        // auto-reply paths — the draft usually predates ensureTagline and the
        // operator shouldn't have to remember to re-add the tagline when editing.
        const { data: workspaceRow } = await supabase
          .from('customers')
          .select('ai_voice_profile')
          .eq('id', account.user_id)
          .maybeSingle()
        outboundBody = ensureTagline(
          trimmed,
          (workspaceRow?.ai_voice_profile ?? undefined) as VoiceProfile | undefined
        )
        const replySent = await sendZohoReply(
          conv.customer_id,
          replySubject,
          outboundBody,
          conv.channel_conversation_id,
          account.user_id
        )
        zohoMessageId = replySent.messageId
        break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new DispatchAmbiguousError(`provider send failed or its outcome is unknown: ${msg}`, false)
  }

  const now = new Date().toISOString()
  const messageId = `op-wa-${Date.now()}`

  const { error: messageInsertError } = await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: messageId,
    sender_type: 'business',
    content: outboundBody,
    message_type: 'text',
    sent_at: now,
    status: 'sent',
    is_internal: false,
    // sent_by carries the path (caye-operator-wa vs caye-dashboard) so future
    // audit can tell HOW the operator initiated the send. generated_by='caye'
    // signals "Caye composed the body" — voice-learning correctly excludes
    // these so Caye doesn't learn from her own output.
    // Autonomous outreach is separately identified. Routine campaign sends
    // are policy-authorized, not falsely presented as per-message owner
    // approvals.
    metadata: {
      sent_by: senderLabel,
      generated_by: 'caye',
      operator_approved: senderLabel !== 'caye-outreach-autonomous',
      ...(senderLabel === 'caye-outreach-autonomous' && meta.autonomy && typeof meta.autonomy === 'object'
        ? { autonomy: meta.autonomy }
        : {}),
      ...(zohoMessageId ? { zoho_message_id: zohoMessageId } : {}),
      ...(idempotencyKey
        ? { idempotency_key: idempotencyKey, idempotency_channel: conv.channel_type }
        : {}),
    },
  })
  if (messageInsertError) {
    throw new DispatchAmbiguousError(`message sent but outbound message was not recorded: ${messageInsertError.message}`, true)
  }

  const { error: conversationUpdateError } = await supabase
    .from('unified_conversations')
    .update({
      last_message_at: now,
      last_message_preview: outboundBody.slice(0, 100),
      last_sender_type: 'business',
      // 'caye' not 'human' — Caye composed the body, even though the operator
      // authorized the send. Honest rendering: chat bubble should match other
      // Caye-authored messages so the operator can see at a glance "Caye
      // wrote this" vs "I typed this." The operator-approved flag in metadata
      // lets the UI surface a "via operator" subtitle/tag if desired.
      last_business_sender_kind: 'caye',
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversationId)
  if (conversationUpdateError) {
    throw new DispatchAmbiguousError(`message sent but conversation state was not recorded: ${conversationUpdateError.message}`, true)
  }

  // Everything above this point is the definite-send boundary: the provider
  // call succeeded and the core receipt (unified_messages + the conversation
  // row) is durably persisted. The two steps below are best-effort follow-up
  // bookkeeping, NOT part of that boundary — recordSalesLifecycleEvent in
  // particular explicitly throws on its own RPC error. Letting either
  // propagate would hand the caller a plain Error for a send that already
  // definitely happened; every caller classifies an unrecognized Error as
  // "definitely did not send" (see DispatchAmbiguousError's doc comment)
  // and would incorrectly free the claim/reservation for a retry — a real
  // duplicate-send risk for outreach email in particular. Log and swallow;
  // never let a bookkeeping failure retroactively look like a dispatch
  // failure once the customer-facing side effect is already confirmed.
  try {
    // Also close out any open escalation row — otherwise it stays pending
    // forever and the "Needs review" stat card keeps counting a thread the
    // operator already replied to.
    await resolveOpenEscalations(supabase, conversationId)

    // One lifecycle seam for both dashboard/manual and cron sends. Only held
    // outreach drafts are lifecycle touches; ordinary replies on an outreach
    // thread are not cold-cadence sends.
    if (meta.source === 'outreach_leads' && typeof meta.lead_id === 'string' &&
        (meta.hold_kind === 'outreach_first_touch' || meta.hold_kind === 'outreach_followup')) {
      await recordSalesLifecycleEvent({
        workspaceId: account.user_id,
        leadId: meta.lead_id,
        event: meta.hold_kind === 'outreach_first_touch' ? 'first_touch_sent' : 'followup_sent',
        eventKey: `outbound:${messageId}`,
        at: now,
      })
    }
  } catch (followUpErr) {
    console.error('[channel-dispatch] post-send bookkeeping failed (send itself already succeeded):', followUpErr)
  }

  return { success: true, channelType: conv.channel_type, messageId, deduped: idempotencyKey ? false : undefined }
}
