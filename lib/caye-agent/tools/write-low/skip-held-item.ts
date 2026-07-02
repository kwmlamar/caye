import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace, resolveOpenEscalations } from './_guards'

interface SkipHeldItemInput {
  conversation_id: string
}

export const skipHeldItem: Tool<SkipHeldItemInput> = {
  name: 'skip_held_item',
  description:
    "Defer a held customer thread without action. Clears the hold and stops surfacing it, but records that it was skipped rather than handled. Use when the operator says 'skip' / 'leave it' / 'ignore' about a specific held item.",
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
        human_agent_reason: 'operator skipped',
      })
      .eq('id', args.conversation_id)

    if (error) return { ok: false, error: error.message }

    await resolveOpenEscalations(supabase, args.conversation_id)

    return {
      ok: true,
      data: { conversation_id: args.conversation_id, skipped: true },
    }
  },
}
