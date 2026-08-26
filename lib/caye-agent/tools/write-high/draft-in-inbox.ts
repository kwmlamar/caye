import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createZohoReplyDraft } from '@/lib/email-ai'
import { checkZohoDraftGate, ZOHO_DRAFT_VERIFIED_KEY } from '@/lib/zoho-draft-gate'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'
import { failedRetryable, needsHuman } from '../result'
import { setLatestActiveWorkStatus } from '@/lib/whatsapp/active-work'

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
    if (!gate.allowed) return { ok: false, error: gate.reason }

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

      await setLatestActiveWorkStatus({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, status: 'completed' })

      return {
        ok: true,
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
      // A provider timeout is not proof that no draft was created. Retrying
      // that case can create duplicate drafts, so it is intentionally a
      // reconciliation/blocking outcome. Explicit throttling/rejection is
      // safe to retry because Zoho returned before accepting a draft.
      const preserved = { conversation_id: args.conversation_id, draft_body: body, sent: false }
      await setLatestActiveWorkStatus({ supabase, workspaceId: ctx.workspaceId, operatorId: ctx.operatorId, status: 'failed' })
      if (/\b(?:429|rate limit|too many requests)\b/i.test(msg)) {
        return { ...failedRetryable('ZOHO_DRAFT_RATE_LIMITED', 'The email provider temporarily rejected this draft save.'), data: preserved }
      }
      if (/\b(?:401|403|unauthori[sz]ed|forbidden|re-?authori[sz])\b/i.test(msg)) {
        return { ...needsHuman('ZOHO_DRAFT_AUTH_REQUIRED', 'The email connection needs to be reconnected before this draft can be saved.'), data: preserved }
      }
      return {
        ...needsHuman('ZOHO_DRAFT_CREATION_UNCERTAIN', 'The email provider did not confirm whether the draft was created.'),
        data: preserved,
      }
    }
  },
}
