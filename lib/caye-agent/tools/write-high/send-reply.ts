import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace, resolveOpenEscalations } from '../write-low/_guards'

interface SendReplyInput {
  conversation_id: string
  body: string
}

export const sendReply: Tool<SendReplyInput> = {
  name: 'send_reply',
  description: `Send a reply to a customer on their thread. HIGH-RISK — this message goes to a real customer in your business's voice.

CONFIRMATION IS ENFORCED IN CODE, not just by this text — the first call only stages the send and returns it un-executed. It does NOT reach the customer, so never tell the operator it was sent. Call it as soon as you've composed the body (using the VOICE PROFILE — write as the operator would, never as Caye). Relay the returned summary to the operator as the draft and ask them to confirm.

Once they reply affirmatively in a NEW message, call confirm_pending_action with the pending_action_id from the staged result. Do NOT call send_reply again to confirm — that only executes if conversation_id + body are byte-identical to what was staged, and rewording even slightly stages a SECOND draft while the first goes nowhere. That has stranded real sends.

If the operator wants changes, call send_reply again with the corrected body — that stages a fresh draft — then confirm THAT id.

KNOW THE THREAD BEFORE YOU WRITE. If you haven't read this conversation's recent messages in this turn, call get_customer_history first. You are often sending into a live exchange the operator can't see all of. If the point you're about to make was already covered on this thread, say so to the operator instead of silently sending it again — "we already answered the refund question 10 minutes ago, still want this?" — and let them decide. A customer who just said "thank you very much" and then receives a colder restatement of policy reads it as a form letter from a business that isn't listening (Karin Roberts, 2026-08-07). Restating IS sometimes right; sending it without noticing never is.

Customer never knows the operator delegated to you.`,
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
          "The exact text to send. Will be delivered as-is to the customer via their channel (email / WhatsApp / IG / Messenger). Already-confirmed copy in the operator's voice.",
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

    try {
      const result = await dispatchOperatorReply(
        args.conversation_id,
        body,
        'caye-dashboard'
      )

      // Clear the held flag since we've now replied. If it wasn't held in
      // the first place, this is a no-op.
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: false,
          human_agent_reason: 'back-office Caye sent reply',
        })
        .eq('id', args.conversation_id)

      // Resolve immediately rather than waiting on escalation-followup's
      // hourly operatorRepliedSince check to notice this same send.
      await resolveOpenEscalations(supabase, args.conversation_id)

      return {
        ok: true,
        data: {
          conversation_id: args.conversation_id,
          channel: result.channelType,
          message_id: result.messageId ?? null,
          sent: true,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Send failed: ${msg}` }
    }
  },
}
