import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { assertConversationOwnedByWorkspace } from './_guards'

interface AddInternalNoteInput {
  conversation_id: string
  note: string
}

export const addInternalNote: Tool<AddInternalNoteInput> = {
  name: 'add_internal_note',
  description:
    'Add an internal note on a customer thread — operator-only, NOT visible to the customer. Use when the operator wants to record context like "Daniel said he\'d call back Sunday" or "give him 10% off next time".',
  risk: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation_id from get_held_queue / search_threads.',
      },
      note: {
        type: 'string',
        description: 'The note text. Operator-only; never sent to the customer.',
      },
    },
    required: ['conversation_id', 'note'],
  },

  async execute(args, ctx) {
    const note = args.note.trim()
    if (!note) return { ok: false, error: 'Note cannot be empty' }

    const supabase = createServiceClient()
    const owned = await assertConversationOwnedByWorkspace(
      supabase,
      args.conversation_id,
      ctx.workspaceId
    )
    if (!owned.ok) return owned

    const { error } = await supabase.from('unified_messages').insert({
      conversation_id: args.conversation_id,
      content: note,
      sender_type: 'system',
      is_internal: true,
      metadata: { source: 'back-office-agent', kind: 'internal_note' },
      sent_at: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { conversation_id: args.conversation_id, note_added: true } }
  },
}
