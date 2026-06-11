import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'

interface SendReplyInput {
  conversation_id: string
  body: string
}

export const sendReply: Tool<SendReplyInput> = {
  name: 'send_reply',
  description: `Send a reply to a customer on their thread. HIGH-RISK — this message goes to a real customer in your business's voice.

CRITICAL — confirmation flow:
1. Before calling this tool, draft the message text in plain conversation with the operator.
2. Show the draft and ask "Want me to send it?" (or equivalent).
3. Wait for explicit confirmation: "yes", "send", "go", "looks good", etc.
4. ONLY then call send_reply with the agreed body.

Never call this tool on the first turn for a customer-facing intent. The operator MUST see and approve the draft first.

Use the VOICE PROFILE in the system prompt to draft customer-facing copy — write as the operator would, never as Caye. Customer never knows the operator delegated to you.`,
  risk: 'high',
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
