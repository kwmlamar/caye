import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from './_guards'

interface ArchiveThreadInput {
  conversation_id: string
}

export const archiveThread: Tool<ArchiveThreadInput> = {
  name: 'archive_thread',
  description:
    'Archive a customer conversation thread so it stops appearing in the active inbox. Use when the operator says "archive that one" / "hide it" / "put it away".',
  risk: 'low',
  roles: ['owner', 'founder'],
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
      .update({ is_archived: true })
      .eq('id', args.conversation_id)
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { conversation_id: args.conversation_id, archived: true } }
  },
}
