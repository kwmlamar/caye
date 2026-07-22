import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'

// Same sliding-window bounds as the back-office loader (context.ts) — last
// 30 messages OR last 24h, whichever is shorter.
const SLIDING_WINDOW_MESSAGES = 30
const SLIDING_WINDOW_HOURS = 24

/**
 * Load the founder↔Admin-Shell conversation history as a Claude
 * MessageParam[]. Unlike loadOperatorContext (back-office), there is no
 * workspace or operator to scope by — admin-shell is a single, global
 * founder thread against caye_admin_shell_messages.
 *
 * Returns oldest-first so it can be passed straight to Claude.
 */
export async function loadAdminShellContext(): Promise<Anthropic.MessageParam[]> {
  const supabase = createServiceClient()
  const cutoffISO = new Date(
    Date.now() - SLIDING_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString()

  const { data, error } = await supabase
    .from('caye_admin_shell_messages')
    .select('direction, body, claude_format, created_at')
    .gte('created_at', cutoffISO)
    .order('created_at', { ascending: false })
    .limit(SLIDING_WINDOW_MESSAGES)

  if (error || !data) {
    console.warn('[caye-agent/admin-shell-context] history load failed:', error?.message)
    return []
  }

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
