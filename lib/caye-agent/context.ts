import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'

// Sliding window bounds locked during the back-office grill-me, Q3:
// last 30 messages OR last 24h, whichever is shorter. For richer history
// the agent has read tools (get_recent_activity etc.) once those land.
const SLIDING_WINDOW_MESSAGES = 30
const SLIDING_WINDOW_HOURS = 24

/**
 * Load the operator↔Caye conversation history as a Claude MessageParam[].
 *
 * Prefers each row's persisted `claude_format` (rich shape including
 * assistant tool_use blocks + user tool_result blocks). Falls back to
 * reconstructing {role, content: body} from `direction` + `body` for
 * legacy rows that predate the column.
 *
 * Scoped to a single operator (not just the workspace) — a workspace can
 * have multiple operators (owner, staff, founder) sharing the back-office
 * channel, and each one's exchange with Caye needs its own memory. Before
 * this scoping existed, Caye's context mixed every operator's messages
 * together, so a reply to one operator could leak context from another's
 * unrelated conversation.
 *
 * Returns oldest-first so it can be passed straight to Claude.
 */
export async function loadOperatorContext(
  workspaceId: string,
  operatorAllowlistId: number | null
): Promise<Anthropic.MessageParam[]> {
  const supabase = createServiceClient()
  const cutoffISO = new Date(
    Date.now() - SLIDING_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString()

  let query = supabase
    .from('caye_operator_messages')
    .select('direction, body, claude_format, created_at')
    .eq('workspace_id', workspaceId)
    .gte('created_at', cutoffISO)

  query = operatorAllowlistId != null
    ? query.eq('operator_allowlist_id', operatorAllowlistId)
    : query.is('operator_allowlist_id', null)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(SLIDING_WINDOW_MESSAGES)

  if (error || !data) {
    console.warn('[caye-agent/context] history load failed:', error?.message)
    return []
  }

  // Walk newest→oldest from the DB, then reverse so Claude sees chronological.
  return data
    .reverse()
    .map((row): Anthropic.MessageParam | null => {
      const stored = row.claude_format as Anthropic.MessageParam | null | undefined
      if (stored && stored.role && stored.content !== undefined) {
        return stored
      }
      if (!row.body) return null
      return {
        role: row.direction === 'inbound' ? 'user' : 'assistant',
        content: row.body,
      }
    })
    .filter((m): m is Anthropic.MessageParam => m !== null)
}
