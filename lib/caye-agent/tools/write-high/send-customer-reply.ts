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

interface SendCustomerReplyInput {
  conversation_id: string
  body: string
}

/**
 * write-high/send-customer-reply.ts
 *
 * PHASE 3 of runtime convergence (2026-08-16) — the front-desk counterpart
 * to back-office's `send_reply` (write-high/send-reply.ts). Deliberately a
 * SEPARATE tool, not the same one reused across modes, for one structural
 * reason: back-office's send_reply is "an OPERATOR relaying/authorizing a
 * message," which is exactly what `gateHighRisk`'s stage-then-confirm-via-
 * a-second-identical-request mechanism was built for (see high-risk-gate.ts
 * — the confirming call is a stand-in for a real human turn). Front-desk is
 * structurally different: it is Caye fielding an inbound CUSTOMER message
 * on her own mandate, with no operator naturally in the loop to produce
 * that second confirming request for the routine case (a price question,
 * an availability check) — wrapping every routine reply in gateHighRisk
 * would force Mrs. Max to hand-approve every customer message, which is
 * not a safety improvement, it's a regression from what production
 * `lib/caye-reply.ts` already does today (autonomous by default, gated by
 * evidence, not by a human round-trip). See the Phase 3 report §12 for the
 * full reasoning and why this was a deliberate, not a default, decision.
 *
 * What this DOES reuse, unmodified:
 *   - `dispatchOperatorReply` (lib/whatsapp/channel-dispatch.ts) — the
 *     same multi-channel (WhatsApp/IG/Messenger/email) send + unified_messages
 *     bookkeeping back-office's send_reply already uses. Tagged with the new
 *     'caye-frontdesk-agent' sender label so this send's provenance is
 *     honestly distinguishable from an operator-authorized one.
 *   - `unsupportedLogisticsTimeClaims` (logistics-grounding.ts) — identical
 *     check back-office's send_reply runs, unchanged.
 *   - `decideDisposition`/`evidence.ts` — the SAME evidence/disposition
 *     policy that already governs `lib/caye-reply.ts`'s production sends
 *     today (see lib/caye-reply.ts's guardDraft/decideDisposition call
 *     site). This is not a new gate; it's the existing one, driven by
 *     evidence the converged front-desk read tools now push onto
 *     `ctx.evidenceCollected` as they run (see tools/types.ts).
 *   - `detectIdentityLeak` (caye-identity-guard.ts) and
 *     `detectUnverifiedPaymentFigure` (policy-figure-guard.ts) — the exact
 *     two functions `guardDraft` composes in production, in the same
 *     order (checked before evidence/disposition, same as
 *     generateCayeAutoReply). `detectUnverifiedPaymentMethodClaim` is new
 *     (same file as the figure guard, same pattern) — closes a real gap
 *     the figure guard never covered: a payment-METHOD assertion ("cash
 *     is not accepted") carries no number, so a live Bimini incident where
 *     Caye told a customer cash wasn't accepted (Mrs. Max had to correct
 *     it herself) passed straight through the figure-only check.
 *
 * Disposition 'send' / 'send_and_flag' → sends autonomously (matching
 * production's autosend philosophy). Disposition 'hold' → sends NOTHING
 * and stages NOTHING for auto-resumable confirmation — this exactly
 * matches production `lib/caye-reply.ts` today too: a hold there is not a
 * resumable staged draft either, it converts to a plain hold a human must
 * act on manually (see `applyAutosendGate`). A resumable-hold /
 * operator-review-and-confirm flow for front-desk is a real, identified
 * Phase 4 seam (report §44), not something forced into this tool now.
 */
export const sendCustomerReply: Tool<SendCustomerReplyInput> = {
  name: 'send_customer_reply',
  description: `Send a reply to the customer on this conversation. HIGH-RISK — this is a real message to a real customer.

This is NOT staged for separate confirmation the way back-office's send_reply is — front-desk replies are evidence-gated, not operator-gated. Call this as soon as you've composed the reply using the tool results you actually retrieved this turn. If the draft states a price, an availability verdict, or an existing-booking detail you have NOT just confirmed with a tool this turn, the send will be held automatically rather than reaching the customer — call the relevant read tool first (check_availability / lookup_price / find_bookings), then call this.

If evidence is insufficient, you'll get back a held/not-sent result explaining what was missing — do not retry with the same unverified claim reworded; either call the missing tool or tell the customer you'll confirm and follow up (and say so honestly, don't invent a number to avoid the hold).`,
  risk: 'high',
  roles: ['owner', 'staff', 'founder'],
  modes: ['front-desk'],
  // Phase 3B — see Tool.terminatesTurn's doc comment. A successful send is
  // the natural end of a front-desk turn; nothing after it needs the model.
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
    const owned = await assertConversationOwnedByWorkspace(supabase, args.conversation_id, ctx.workspaceId)
    if (!owned.ok) return owned

    const authoritativeThread = await fetchAuthoritativeThread(supabase, args.conversation_id)
    const unsupportedLogistics = unsupportedLogisticsTimeClaims(body, authoritativeThread)
    if (unsupportedLogistics.length > 0) {
      return {
        ok: false,
        status: 'CONFLICT',
        error_code: 'UNGROUNDED_LOGISTICS_TIME',
        error: `Draft associates a time with an event the customer thread does not support: ${unsupportedLogistics.join(', ')}. Re-read the thread and correct the schedule; nothing was sent.`,
      }
    }

    // Identity-leak + payment-figure/method guards — the SAME checks
    // production's guardDraft runs, in the same order (checked before
    // evidence/disposition, exactly mirroring generateCayeAutoReply's
    // `if (blocked) { ...hold... }` coming before its evidence verdict).
    // Closes the parity gap the "final pre-canary closure" pass exists
    // for: a real Bimini incident had Caye assert cash was not accepted
    // with nothing in code to catch it — detectUnverifiedPaymentMethodClaim
    // is new (lib/policy-figure-guard.ts) specifically for that class of
    // claim; the other two are reused from production verbatim.
    const identityLeak = detectIdentityLeak(body)
    if (identityLeak) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'IDENTITY_LEAK',
        error: `Identity guard: ${identityLeak}. Nothing was sent — rewrite without revealing you're AI/Caye and try again.`,
      }
    }
    const [businessFacts, businessSentThread] = await Promise.all([
      fetchBusinessFacts(ctx.workspaceId),
      // Grounds a genuine operator correction sent directly to THIS
      // customer (the Juli-class case: Mrs. Max told the customer cash
      // is accepted after Caye wrongly said otherwise) — see
      // fetchAuthoritativeThread's doc comment for why this is
      // business-sender-only, not the whole thread.
      fetchAuthoritativeThread(supabase, args.conversation_id, 'business'),
    ])
    const factsGrounding = [businessFacts.map((f) => f.fact).join('\n'), businessSentThread]
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
    // CAY-92: third-party/partner coordination and refund/cancellation are
    // consequential commitments a customer will hold the business to — same
    // reasoning as the payment guards above, same factsGrounding (business
    // facts + this thread's own owner-sent messages), extended to the two
    // claim categories from the Jonathan snorkeling/Snuba incident.
    const thirdPartyCommitment = detectUnsupportedThirdPartyCommitment(body, factsGrounding)
    if (thirdPartyCommitment) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNSUPPORTED_THIRD_PARTY_COMMITMENT',
        error: `Commitment guard: ${thirdPartyCommitment}. Nothing was sent — do not promise a partner/vendor arrangement that isn't documented; say you'll confirm and follow up instead.`,
      }
    }
    const refundCommitment = detectUnsupportedRefundCommitment(body, factsGrounding)
    if (refundCommitment) {
      return {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'UNSUPPORTED_REFUND_COMMITMENT',
        error: `Commitment guard: ${refundCommitment}. Nothing was sent — do not promise a refund/cancellation outcome that isn't documented; say you'll confirm and follow up instead.`,
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
      // Idempotency key (final pre-canary closure) — undefined unless the
      // caller set ctx.triggeringMessageId, in which case a webhook-level
      // retry of the same inbound message collapses onto this one send
      // instead of dispatching twice. See ToolContext.triggeringMessageId
      // and dispatchOperatorReply's idempotencyKey param for the full
      // reasoning.
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
            human_agent_reason: 'Caye sent this autonomously but flagged it for a check — see reply for why.',
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
          // Read by runToolLoop's terminatesTurn handling (Phase 3B) as
          // the turn's final replyText — the delivered body IS the reply,
          // there is no separate "what the model said about it" to prefer.
          delivered_text: body,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Send failed: ${msg}` }
    }
  },
}
