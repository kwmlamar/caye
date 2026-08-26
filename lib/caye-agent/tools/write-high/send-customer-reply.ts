import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import { fetchBusinessFacts } from '@/lib/business-facts'
import { detectIdentityLeak } from '@/lib/caye-identity-guard'
import {
  detectUnverifiedPaymentFigure,
  detectUnverifiedPaymentMethodClaim,
  detectUnsupportedThirdPartyCommitment,
  detectUnsupportedRefundCommitment,
} from '@/lib/policy-figure-guard'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { unsupportedLogisticsTimeClaims } from '../../logistics-grounding'
import { fetchAuthoritativeThread } from '../../fetch-authoritative-thread'
import { decideDisposition, ownerNoteFor, type EvidenceSet } from '../../evidence'
import { extractDollarAmounts, assertsAvailability } from '../../draft-claims'
import {
  detectConsequentialPolarityConflict,
  fetchScopedOwnerInstructionText,
  validateAuthoritativeBookingStatusClaims,
  validateAuthoritativeBookingTimeClaims,
} from '../../consequential-claim-grounding'
import { validateFrontDeskContext } from '../../frontdesk-context-guard'
import { staleDateOverrideConflict } from '../../date-override-revalidation'
import { completeConversationExecution, resolveConversationExecutionAfterFailure, validateConversationExecution } from '@/lib/conversation-execution'

interface SendCustomerReplyInput {
  conversation_id: string
  body: string
}

/**
 * Customer-facing front-desk send boundary. The model may compose freely, but
 * no consequential claim leaves this function until identity, current-channel
 * context, policy, authority, evidence, booking state, and execution gates pass.
 */
export const sendCustomerReply: Tool<SendCustomerReplyInput> = {
  name: 'send_customer_reply',
  description: `Send a reply to the customer on this conversation. HIGH-RISK — this is a real message to a real customer.

Front-desk replies are evidence-gated rather than separately operator-gated. If the draft states a price, availability verdict, consequential partner/refund/future-action commitment, existing-booking status, or tells a customer to initiate the channel they are already using, the send is validated against authoritative state and scoped owner instruction before execution. Call the relevant read tool first; do not retry the same unsupported claim reworded.`,
  risk: 'high',
  roles: ['owner', 'staff', 'founder'],
  modes: ['front-desk'],
  terminatesTurn: true,
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation_id this reply is on.',
      },
      body: {
        type: 'string',
        description: 'The exact text to send to the customer, in the business voice.',
      },
    },
    required: ['conversation_id', 'body'],
  },

  async execute(args, ctx) {
    const body = args.body.trim()
    if (!body) return { ok: false, error: 'Body cannot be empty' }

    const supabase = createServiceClient()
    const owned = await assertConversationOwnedByWorkspace(
      supabase,
      args.conversation_id,
      ctx.workspaceId
    )
    if (!owned.ok) return owned

    const authoritativeThread = await fetchAuthoritativeThread(
      supabase,
      args.conversation_id
    )
    const unsupportedLogistics = unsupportedLogisticsTimeClaims(
      body,
      authoritativeThread
    )
    if (unsupportedLogistics.length > 0) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'UNGROUNDED_LOGISTICS_TIME',
        error: `Draft associates a time with an event the customer thread does not support: ${unsupportedLogistics.join(', ')}. Re-read the thread and correct the schedule; nothing was sent.`,
      }
    }

    const identityLeak = detectIdentityLeak(body)
    if (identityLeak) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'IDENTITY_LEAK',
        error: `Identity guard: ${identityLeak}. Nothing was sent — rewrite without revealing you're AI/Caye and try again.`,
      }
    }

    const [businessFacts, businessSentThread, ownerInstructionText] = await Promise.all([
      fetchBusinessFacts(ctx.workspaceId),
      fetchAuthoritativeThread(supabase, args.conversation_id, 'business'),
      fetchScopedOwnerInstructionText(supabase, args.conversation_id),
    ])

    const businessFactsText = businessFacts.map((f) => f.fact).join('\n')
    const factsGrounding = [businessFactsText, businessSentThread]
      .filter(Boolean)
      .join('\n')
    const consequentialGrounding = [businessFactsText, ownerInstructionText]
      .filter(Boolean)
      .join('\n')

    // CAY-110: channel state is a deterministic fact, not prose context for
    // the model to maybe notice. The same boundary also prevents polite
    // future-tense promises from assigning work that no tool/owner/policy has
    // actually authorized.
    const contextConflict = await validateFrontDeskContext({
      db: supabase,
      conversationId: args.conversation_id,
      body,
      groundingText: consequentialGrounding,
    })
    if (contextConflict) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: contextConflict.code,
        error: `Front-desk context guard: ${contextConflict.message}. Nothing was sent — rewrite using the channel already in progress or obtain authoritative support for the future action.`,
      }
    }

    const paymentFigure = detectUnverifiedPaymentFigure(body, factsGrounding)
    if (paymentFigure) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNVERIFIED_PAYMENT_FIGURE',
        error: `Payment-figure guard: ${paymentFigure}. Nothing was sent — that number isn't in any business fact.`,
      }
    }

    const paymentMethod = detectUnverifiedPaymentMethodClaim(body, factsGrounding)
    if (paymentMethod) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNVERIFIED_PAYMENT_METHOD',
        error: `Payment-method guard: ${paymentMethod}. Nothing was sent — do not state a payment-method policy that isn't documented; say you'll confirm and follow up instead.`,
      }
    }

    const polarityConflict = detectConsequentialPolarityConflict(
      body,
      consequentialGrounding
    )
    if (polarityConflict) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'CONSEQUENTIAL_CLAIM_POLARITY_CONFLICT',
        error: `Commitment guard: ${polarityConflict}. Nothing was sent — authoritative business policy says the opposite.`,
      }
    }

    const thirdPartyCommitment = detectUnsupportedThirdPartyCommitment(
      body,
      consequentialGrounding
    )
    if (thirdPartyCommitment) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNSUPPORTED_THIRD_PARTY_COMMITMENT',
        error: `Commitment guard: ${thirdPartyCommitment}. Nothing was sent — do not promise a partner/vendor arrangement that isn't documented or explicitly owner-authorized for this thread.`,
      }
    }

    const refundCommitment = detectUnsupportedRefundCommitment(
      body,
      consequentialGrounding
    )
    if (refundCommitment) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNSUPPORTED_REFUND_COMMITMENT',
        error: `Commitment guard: ${refundCommitment}. Nothing was sent — do not promise a refund/cancellation outcome that isn't documented or explicitly owner-authorized for this thread.`,
      }
    }

    const bookingStatusConflict = await validateAuthoritativeBookingStatusClaims(
      supabase,
      ctx.workspaceId,
      args.conversation_id,
      body,
      ownerInstructionText
    )
    if (bookingStatusConflict) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'BOOKING_STATUS_CONFLICT',
        error: `Booking-status guard: ${bookingStatusConflict}. Nothing was sent — re-read authoritative booking state or get an explicit operator instruction.`,
      }
    }

    // 2026-08-26 Sonja Pettus incident (see consequential-claim-grounding.ts)
    // — no owner-instruction bypass: a stated time change is not evidence
    // the booking record changed.
    const bookingTimeConflict = await validateAuthoritativeBookingTimeClaims(
      supabase,
      ctx.workspaceId,
      args.conversation_id,
      body
    )
    if (bookingTimeConflict) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'UNGROUNDED_BOOKING_TIME',
        error: `${bookingTimeConflict}. The booking must actually be rescheduled before the customer is told the time changed. Nothing was sent.`,
      }
    }

    const evidence: EvidenceSet = new Set(ctx.evidenceCollected ?? [])
    const quotesPrice = extractDollarAmounts(body).length > 0
    const claimsAvailability = assertsAvailability(body)
    const disposition = decideDisposition({ evidence, quotesPrice, claimsAvailability })

    if (disposition.disposition === 'hold') {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'INSUFFICIENT_EVIDENCE',
        error: ownerNoteFor(disposition),
        data: { missing: disposition.missing },
      }
    }

    // LAST content check before dispatch, deliberately — not run earlier in
    // this function. An operator can teach a date-specific restriction (via
    // the operator-learning router) WHILE this exact turn is in flight; the
    // draft above was composed against whatever availability state existed
    // when the prompt was built, which can be seconds to minutes stale by
    // the time execution reaches here. Re-fetches service_date_overrides
    // fresh, right now, rather than trusting anything read earlier.
    //
    // COMPOSITION WITH PR #132 (conversation-execution-coordination — now
    // merged): confirmed by this merge that validateConversationExecution
    // sits exactly where this comment predicted it would, immediately
    // before dispatchOperatorReply. The two checks are adjacent, in order,
    // exactly as planned:
    //   1. staleDateOverrideConflict (this check)   — is the CONTENT still true?
    //   2. validateConversationExecution (#132)     — is this call still the
    //      valid holder of the right to send at all?
    //   3. dispatchOperatorReply                     — send.
    // Content freshness and execution-ownership are orthogonal concerns —
    // neither needs the other's internals — so no shared coordinator/lock
    // object was needed; positional adjacency in this one function is the
    // entire integration. Nothing here imports from or depends on
    // conversation-execution.ts's internals, and nothing there depends on
    // this check — a stale-date-override rejection returns before
    // validateConversationExecution is ever called, so a doomed send never
    // consumes/burns the execution claim either.
    const staleOverride = await staleDateOverrideConflict(supabase, ctx.workspaceId, args.conversation_id, body)
    if (staleOverride) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'STALE_DATE_OVERRIDE',
        error: `Availability changed since this draft was composed: ${staleOverride} Nothing was sent — re-check availability and rewrite.`,
      }
    }

    // Set the instant dispatchOperatorReply returns successfully. Guards the
    // catch below: once true, a LATER failure (completing the coordinator
    // record, the send_and_flag update, anything) must never be treated as
    // "nothing was sent" — the customer-facing side effect already happened.
    let dispatched = false
    try {
      if (ctx.executionClaimId) {
        const execution = await validateConversationExecution({
          claimId: ctx.executionClaimId,
          triggeringMessageId: ctx.triggeringMessageId,
        })
        if (!execution.ok) {
          return { ok: false, status: 'CONFLICT', error_code: 'STALE_CONVERSATION_EXECUTION', error: `Conversation changed while this reply was being prepared (${execution.reason}). Nothing was sent; reload the current thread.` }
        }
      }
      const result = await dispatchOperatorReply(
        args.conversation_id,
        body,
        'caye-frontdesk-agent',
        ctx.triggeringMessageId ?? undefined
      )
      dispatched = true

      // The send is CONFIRMED at this point. If completing the coordinator
      // record itself now fails, that must never be treated as a dispatch
      // failure — the reservation just stays "reserved" (never abandoned),
      // which still correctly blocks a second answer to this same inbound
      // turn (see the migration's crash-point-5 doc comment).
      if (ctx.executionClaimId) {
        await completeConversationExecution(ctx.executionClaimId).catch((completeErr) => {
          console.error('[send-customer-reply] dispatch succeeded but completing the execution claim failed (safe — left unresolved rather than freed for retry):', completeErr)
        })
      }

      if (disposition.disposition === 'send_and_flag') {
        await supabase
          .from('unified_conversations')
          .update({
            human_agent_enabled: true,
            human_agent_reason:
              'Caye sent this autonomously but flagged it for a check — see reply for why.',
          })
          .eq('id', args.conversation_id)
      }

      return {
        ok: true,
        data: {
          conversation_id: args.conversation_id,
          channel: result.channelType,
          message_id: result.messageId ?? null,
          sent: true,
          flagged_for_review: disposition.disposition === 'send_and_flag',
          delivered_text: body,
        },
      }
    } catch (err) {
      if (ctx.executionClaimId && !dispatched) await resolveConversationExecutionAfterFailure(ctx.executionClaimId, err)
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Send failed: ${msg}` }
    }
  },
}
