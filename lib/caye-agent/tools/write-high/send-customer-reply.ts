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
} from '../../consequential-claim-grounding'

interface SendCustomerReplyInput {
  conversation_id: string
  body: string
}

/**
 * Customer-facing front-desk send boundary. The model may compose freely, but
 * no consequential claim leaves this function until identity, policy,
 * authority, evidence, booking state, and execution gates have passed.
 */
export const sendCustomerReply: Tool<SendCustomerReplyInput> = {
  name: 'send_customer_reply',
  description: `Send a reply to the customer on this conversation. HIGH-RISK — this is a real message to a real customer.

Front-desk replies are evidence-gated rather than separately operator-gated. If the draft states a price, availability verdict, consequential partner/refund commitment, or existing-booking status that is not supported by authoritative state or scoped owner instruction, the send is held automatically. Call the relevant read tool first; do not retry the same unsupported claim reworded.`,
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
      // Payment-method corrections historically use customer-visible business
      // messages as grounding. Preserve that established behavior.
      fetchAuthoritativeThread(supabase, args.conversation_id, 'business'),
      // Consequential owner authority is narrower: autonomous Caye messages
      // are excluded so a prior hallucination cannot self-authorize.
      fetchScopedOwnerInstructionText(supabase, args.conversation_id),
    ])

    const businessFactsText = businessFacts.map((f) => f.fact).join('\n')
    const factsGrounding = [businessFactsText, businessSentThread]
      .filter(Boolean)
      .join('\n')
    const consequentialGrounding = [businessFactsText, ownerInstructionText]
      .filter(Boolean)
      .join('\n')

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

    // CAY-97: concept overlap is not agreement. Contradictory authoritative
    // grounding blocks before the older presence-based commitment guards run.
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

    // CAY-97: existing-booking status is authoritative system state, not a
    // language-model inference. Exact conversation-linked booking rows win;
    // legacy rows fall back to verified customer identity. Missing,
    // contradictory, or mismatched state holds unless the operator explicitly
    // authorized that scoped status claim on this thread.
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

    try {
      const result = await dispatchOperatorReply(
        args.conversation_id,
        body,
        'caye-frontdesk-agent',
        ctx.triggeringMessageId ?? undefined
      )

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
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Send failed: ${msg}` }
    }
  },
}
