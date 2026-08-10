import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createZohoReplyDraft } from '@/lib/email-ai'
import { checkZohoDraftGate, ZOHO_DRAFT_VERIFIED_KEY } from '@/lib/zoho-draft-gate'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from './_guards'

interface DraftInInboxInput {
  conversation_id: string
  body: string
}

/**
 * Put a composed reply in the operator's own Drafts folder instead of
 * sending it.
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
 */
export const draftInInbox: Tool<DraftInInboxInput> = {
  name: 'draft_in_inbox',
  description: `Write a reply into the operator's OWN email Drafts folder, on the customer's thread. Does NOT send — nothing reaches the customer. They open their mail client, add anything you can't (photos, files, attachments), and send it themselves.

USE THIS WHENEVER ATTACHMENTS ARE INVOLVED. You cannot attach photos or files to a send_reply. The moment the operator says they want to send a customer images, documents, or anything you can't produce, offer this instead of collecting the files — say so BEFORE they start sending them to you.

Also right when the operator wants to add a personal note in their own words, or wants the message sitting in their inbox to send later on their own timing.

Not a replacement for send_reply. If there's no attachment and no reason to hand it over, send_reply is fewer steps for them.

Email threads only — the operator's mailbox is the delivery surface, so this does nothing for a WhatsApp or Instagram thread.`,
  risk: 'low',
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
      return { ok: false, error: `Draft failed: ${msg}` }
    }
  },
}
