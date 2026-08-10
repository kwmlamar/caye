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

    const { data: marked, error } = await supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: false,
        human_agent_reason: args.note?.trim() || 'operator handled directly',
      })
      .eq('id', args.conversation_id)
      .select('customer_name, customer_id, channel_type, connected_account_id')
      .maybeSingle()

    if (error) return { ok: false, error: error.message }

    await resolveOpenEscalations(supabase, args.conversation_id)

    // Same person, more than one thread. Bimini carries both "Jeff A
    // Montenaro" (jam43065@aol.com) and "Jeff Montenaro" (a receipt
    // reference); on 2026-08-09 mark_handled cleared the receipt thread while
    // the real email thread stayed held, and the next get_held_queue still
    // listed Jeff. Caye explained that away to the owner as the queue needing
    // "a moment to fully clear" — it did not; the wrong row had been marked.
    // Reporting the leftovers turns a silent mis-target into something the
    // model can see and raise.
    const stillHeld = await siblingHoldsFor(
      supabase,
      ctx.workspaceId,
      marked?.customer_name ?? null,
      args.conversation_id
    )

    return {
      ok: true,
      data: {
        conversation_id: args.conversation_id,
        marked_handled: true,
        // Echo WHO was cleared so a mis-targeted id is visible in the result
        // rather than assumed correct.
        customer: marked?.customer_name ?? marked?.customer_id ?? null,
        channel: marked?.channel_type ?? null,
        reason: args.note?.trim() || 'operator handled directly',
        other_held_threads_same_person: stillHeld,
        ...(stillHeld.length > 0
          ? {
              warning:
                'This person has other threads still held. You very likely marked the wrong one, ' +
                'or they genuinely have two open threads. Tell the operator plainly and ask which ' +
                'they meant — do not claim the queue just needs time to update.',
            }
          : {}),
      },
    }
  },
}

/** Other still-held threads in THIS workspace whose customer name overlaps
 *  the one just cleared. */
async function siblingHoldsFor(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  customerName: string | null,
  excludeConversationId: string
): Promise<{ conversation_id: string; customer: string | null }[]> {
  const name = customerName?.trim()
  // Needs at least a surname-ish token to be worth matching on; a blank or
  // one-character name would match half the workspace.
  if (!name || name.length < 3) return []

  // Longest token in the name — surnames discriminate, first names and middle
  // initials don't. "Jeff A Montenaro" and "Jeff Montenaro" both yield
  // "Montenaro", which is exactly the pair that went wrong.
  const token = name
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)[0]
  if (!token) return []

  // Scope to this workspace's own accounts — an unscoped name search would
  // reach across every tenant in the table.
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = ((accounts ?? []) as { id: string }[]).map((a) => a.id)
  if (accountIds.length === 0) return []

  const { data } = await supabase
    .from('unified_conversations')
    .select('id, customer_name')
    .in('connected_account_id', accountIds)
    .eq('human_agent_enabled', true)
    .eq('is_archived', false)
    .ilike('customer_name', `%${token}%`)
    .neq('id', excludeConversationId)
    .limit(5)

  return ((data ?? []) as { id: string; customer_name: string | null }[]).map((r) => ({
    conversation_id: r.id,
    customer: r.customer_name,
  }))
}
