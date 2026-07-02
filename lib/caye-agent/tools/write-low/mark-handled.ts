import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace, resolveOpenEscalations } from './_guards'

interface MarkHandledInput {
  conversation_id: string
  note?: string
}

export const markHandled: Tool<MarkHandledInput> = {
  name: 'mark_handled',
  description:
    "Mark a held customer thread as handled — clears the hold flag so Caye stops waiting on the operator and stops surfacing it. Use when the operator says 'I got it' / 'handled' / 'I replied directly' about a held item. Does NOT send a customer reply; that's send_reply (high-risk, comes later).",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation_id from get_held_queue / search_threads.',
      },
      note: {
        type: 'string',
        description: 'Optional short reason — e.g. "replied via Zoho directly". Stored as human_agent_reason for audit.',
      },
    },
    required: ['conversation_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const owned = await assertConversationOwnedByWorkspace(
      supabase,
      args.conversation_id,
      ctx.workspaceId
    )
    if (!owned.ok) return owned

    const { error } = await supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: false,
        human_agent_reason: args.note?.trim() || 'operator handled directly',
      })
      .eq('id', args.conversation_id)

    if (error) return { ok: false, error: error.message }

    await resolveOpenEscalations(supabase, args.conversation_id)

    return {
      ok: true,
      data: {
        conversation_id: args.conversation_id,
        marked_handled: true,
        reason: args.note?.trim() || 'operator handled directly',
      },
    }
  },
}
