import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createZohoReplyDraft } from '@/lib/email-ai'
import { checkZohoDraftGate, ZOHO_DRAFT_VERIFIED_KEY } from '@/lib/zoho-draft-gate'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { failedPermanent, failedRetryable, needsHuman, httpStatusFrom } from '../result'
import { updateActiveWork } from '@/lib/whatsapp/active-work'

interface DraftInInboxInput {
  conversation_id: string
  body: string
}

/**
 * Put a composed reply in the operator's own Drafts folder instead of
 * showing it in this conversation.
 *
 * WHY THIS EXISTS (2026-08-09)
 * Mrs. Max wanted to send eleven tour photos to a guest with a written
 * apology. Caye can compose the apology but cannot attach images, and said
 * so only after twenty minutes of collecting photos and revising drafts. Her
 * own proposal was the right one: "can you send it to my email as a draft and
 * then i will add the photos." Caye's answer was "I'm not able to push a
 * draft directly into your Gmail inbox" — and she did the whole thing by hand.
 *
 * She is on Zoho, not Gmail, and the capability to write a Zoho draft has
 * existed unused in email-ai.ts the entire time.
 *
 * This is deliberately NOT a send. Nothing reaches the guest. The draft lands
 * on the real thread (threading via findReplyTargetZohoMessageId), so she
 * opens her normal mail client, attaches whatever she likes, and sends it
 * herself — which is the part Caye genuinely cannot do.
 *
 * RISK RAISED low → high (2026-08-17, Pam Ott incident)
 * On the real Bimini thread, Mrs. Max asked for a plain conversational
 * "draft please" three times in a row (never once asking for anything to be
 * saved to her email). The first two times Caye correctly staged send_reply
 * and showed the draft in WhatsApp. The third and fourth time — after Caye
 * herself asked "should I stage it as a send_reply?" and got no direct
 * answer — she silently called this tool instead and told Mrs. Max to go
 * open her email, twice, with nothing to confirm first. Low-risk execution
 * meant that silent redirect happened with no checkpoint at all.
 *
 * CAY-9 (2026-08-17) adds a second, independent protection before the normal
 * high-risk staging flow: the current operator turn must establish explicit
 * external-draft intent. That check lives outside this raw tool in registry.ts
 * and is repeated before confirm_pending_action claims the staged row, so a
 * transient history-read failure cannot occur after the action has been
 * atomically marked executed.
 *
 * FAILURE CLASSIFICATION (CAY-139, 2026-08-26 — repeated live Bimini draft
 * failure reported as "the staging system is down" / "backend issue" with no
 * evidence behind either claim)
 * The catch block below and the gate check above it distinguish FOUR outcomes,
 * not one generic failure:
 *   - rate limited (429/"too many requests") — Zoho rejected the request
 *     BEFORE creating anything. Safe to retry; see orchestrator.ts's
 *     MAX_ATTEMPTS override for this tool name.
 *   - auth required (401/403/"unauthorized") — nothing was created, and no
 *     retry can fix an expired/missing token. Actionable: reconnect.
 *   - deterministically rejected (an explicit 4xx Zoho returned synchronously,
 *     other than 401/403/429) — nothing was created. Not ambiguous: a 4xx
 *     means Zoho validated and definitely rejected the request before
 *     creating anything.
 *   - creation uncertain (no HTTP status at all — network/timeout/parse
 *     failure — OR an explicit 5xx) — Zoho may have received and processed
 *     the request before our side lost the response (network/timeout), or
 *     may have persisted the write before failing server-side (5xx). Either
 *     way there is no way to prove nothing was created. This is the ONLY
 *     class that marks active work 'uncertain' rather than 'failed', and the
 *     only class this tool refuses to retry even when the orchestrator's
 *     budget would otherwise allow it (status NEEDS_HUMAN, not
 *     FAILED_RETRYABLE). A successful-looking response with no draft id at
 *     all (draftId: null) is treated the same way — see the `!draftId`
 *     check below.
 * The verification-gate block above (checkZohoDraftGate) is its own fifth,
 * always-deterministic case: never ambiguous, never retryable, and distinct
 * from a live provider failure — it means the one-time safety check has
 * never been run on this workspace, not that anything is broken.
 * lib/caye-agent/orchestrator.ts's draftInInboxFailureGuidance() turns each
 * of these into the exact, narrow, evidence-backed sentence the model is
 * told to say — no gap left for it to fill with "the system is down."
 */
export const draftInInbox: Tool<DraftInInboxInput> = {
  name: 'draft_in_inbox',
  description: `HIGH-RISK — puts a draft into the operator's OWN external email Drafts folder, on the customer's thread, instead of showing it in this conversation. Staged and confirmed the same way send_reply is: the first call only stages it and returns it un-executed — call confirm_pending_action once the operator agrees, exactly as for any other high-risk tool.

Does NOT send — nothing reaches the customer.

THE WORD "DRAFT" ALONE DOES NOT MEAN THIS TOOL. "Draft please" / "draft a reply" / "write something for X" / "show me what you'd say" mean COMPOSE AND SHOW IT HERE — call send_reply and relay its staged draft in this same conversation, the same as any other draft request, regardless of whether the customer's own thread happens to be email. Only call this tool when the operator EXPLICITLY asks for the external artifact — "put this in my email drafts", "save it as a Gmail/email draft", "create an email draft for her", "I'll add the photos and send it myself" — or when attachments are the reason (below).

EXTERNAL-DRAFT INTENT IS NOT STICKY. Even if this tool was used earlier on the same customer thread, later requests like "draft please", "change the price", "make it shorter", or "add the group size" are ordinary compose/revise requests again unless the CURRENT operator turn explicitly asks for Gmail/email Drafts. Never carry an old destination forward by conversational inertia.

USE THIS WHEN ATTACHMENTS ARE INVOLVED. You cannot attach photos or files to a send_reply. The moment the operator says they want to send a customer images, documents, or anything you can't produce, offer this instead of collecting the files — say so BEFORE they start sending them to you.

Email threads only — the operator's mailbox is the delivery surface, so this does nothing for a WhatsApp or Instagram thread.`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation_id from get_held_queue / get_customer / search_threads.',
      },
      body: {
        type: 'string',
        description:
          "The full draft text, already in the operator's voice — same standard as send_reply. They will attach files and send it as-is.",
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

    // Fail closed until save-as-draft has been proven not to send. See
    // lib/zoho-draft-gate.ts — an unverified `mode: "draft"` that Zoho
    // ignores would deliver this text to the guest.
    const { data: setting } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', ZOHO_DRAFT_VERIFIED_KEY)
      .maybeSingle()
    const gate = checkZohoDraftGate(setting?.value)
    if (!gate.allowed) {
      // Deterministic, permanent, and NOT a live provider/system failure —
      // give it its own error_code (rather than falling through to a bare
      // {ok:false} that normalizeResult would flatten into a generic
      // FAILED_PERMANENT) so guidanceFor can tell the model exactly what
      // this is instead of leaving it to guess "backend issue."
      await updateActiveWork({
        supabase,
        workspaceId: ctx.workspaceId,
        operatorId: ctx.operatorId,
        work: ctx.activeWork,
        artifact: body,
        status: 'failed',
      })
      return failedPermanent('ZOHO_DRAFT_MODE_NOT_VERIFIED', gate.reason ?? 'Draft mode is not verified.')
    }

    const { data: conv } = await supabase
      .from('unified_conversations')
      .select('customer_id, customer_name, channel_type, channel_conversation_id, metadata')
      .eq('id', args.conversation_id)
      .maybeSingle()

    if (!conv) return { ok: false, error: 'Conversation not found' }
    if (conv.channel_type !== 'email') {
      return {
        ok: false,
        error: `This is a ${conv.channel_type} thread, not email — there's no mailbox to draft into. Use send_reply, or tell the operator they'll need to send the attachment from their phone.`,
      }
    }

    const meta = (conv.metadata ?? {}) as Record<string, unknown>
    const subject = (meta.subject as string) || '(no subject)'
    const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`

    try {
      const { draftId } = await createZohoReplyDraft(
        conv.customer_id as string,
        replySubject,
        body,
        conv.channel_conversation_id as string,
        ctx.workspaceId
      )

      if (!draftId) {
        // Zoho answered 200/201 (createZohoReplyDraft only returns instead
        // of throwing on that) but the response carried no message id to
        // point back at — we cannot prove a specific draft exists, only
        // that Zoho didn't reject the request. Product invariant #1 (CAY-139):
        // "draft in inbox" must mean a real provider-side draft that can be
        // retrieved/identified afterward, so an HTTP success with no
        // identity is NOT reported as unconditional success — it is the
        // same honest 'uncertain' outcome as a request that never got a
        // response at all, not a false positive.
        await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'uncertain' })
        return {
          ...needsHuman(
            'ZOHO_DRAFT_ID_MISSING',
            'The email provider accepted the request but did not return a draft id, so this cannot be confirmed.'
          ),
          data: { conversation_id: args.conversation_id, draft_body: body, sent: false },
        }
      }

      await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'completed' })

      return {
        ok: true,
        status: 'SUCCESS',
        data: {
          conversation_id: args.conversation_id,
          drafted_for: conv.customer_name ?? conv.customer_id,
          subject: replySubject,
          draft_id: draftId,
          sent: false,
          // Spelled out because the distinction is the entire point of the
          // tool, and reporting it as "sent" would be a trust failure.
          next_step:
            "It's in their Drafts folder on this thread, not sent. Tell them to open their email, attach what they need, and send it from there.",
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const preserved = { conversation_id: args.conversation_id, draft_body: body, sent: false }

      // Explicit throttling — Zoho rejected the request BEFORE creating
      // anything. Safe to retry: see orchestrator.ts's MAX_ATTEMPTS override
      // for this tool name (budget 2, only for FAILED_RETRYABLE).
      if (/\b(?:429|rate limit|too many requests)\b/i.test(msg)) {
        await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'failed' })
        return { ...failedRetryable('ZOHO_DRAFT_RATE_LIMITED', 'The email provider temporarily rejected this draft save.'), data: preserved }
      }

      // Auth/connection is broken. Nothing was created, and retrying blindly
      // cannot fix a missing/expired token — actionable, not ambiguous.
      // Covers both a live 401/403 from Zoho AND the pre-network throws
      // getZohoContext (lib/zoho-token.ts) raises before any HTTP call is
      // even made — "No active Zoho account...", "No refresh token...",
      // "Token refresh failed...". Those three carry no HTTP status at all,
      // so without matching their exact wording here they would have fallen
      // through to the httpStatusFrom check below (also no match, since
      // there's no status to find) and landed in the 'uncertain' bucket —
      // wrongly implying a draft might exist when nothing was ever attempted.
      if (
        /\b(?:401|403|unauthori[sz]ed|forbidden|re-?authori[sz]|reconnect)\b/i.test(msg) ||
        /no active .{0,30}account|no refresh token|token refresh failed/i.test(msg)
      ) {
        await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'failed' })
        return { ...needsHuman('ZOHO_DRAFT_AUTH_REQUIRED', 'The email connection needs to be reconnected before this draft can be saved.'), data: preserved }
      }

      // An explicit 4xx (400/404/409/422...) means Zoho validated and
      // synchronously rejected the request as malformed/invalid before
      // creating anything — deterministic, not ambiguous. No draft exists;
      // safe to report as a plain failure, same as the two branches above.
      const status = httpStatusFrom(msg)
      if (status !== null && status >= 400 && status < 500) {
        await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'failed' })
        return { ...failedPermanent('ZOHO_DRAFT_REJECTED', 'The email provider rejected this draft.'), data: preserved }
      }

      // Either no HTTP status was found at all (network error, timeout,
      // unparseable response) OR an explicit 5xx server error. Neither
      // proves nothing was created: a 5xx can fire after the provider has
      // already processed and persisted the write, and a network/timeout
      // failure means we simply never heard back. There is genuinely no way
      // to tell from here. Never retry this automatically (a blind retry
      // risks a real duplicate draft on the customer's thread) and never
      // report it as a definite failure — mark active work 'uncertain', not
      // 'failed'. See lib/whatsapp/active-work.ts.
      await updateActiveWork({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, work: ctx.activeWork, artifact: body, status: 'uncertain' })
      return {
        ...needsHuman('ZOHO_DRAFT_CREATION_UNCERTAIN', 'The email provider did not confirm whether the draft was created.'),
        data: preserved,
      }
    }
  },
}
