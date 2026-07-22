import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { summarizeTurnBody } from '@/lib/caye-operator-messages'

/**
 * Persists every turn produced during an admin-shell cayeAgent tool loop
 * so the next sliding-window load (loadAdminShellContext) reconstructs
 * the full Claude history. Mirrors persistAgentTurns (caye-operator-
 * messages.ts) but targets caye_admin_shell_messages — a single global
 * founder thread, no workspace/operator columns.
 */
export async function persistAdminShellTurns(
  supabase: ReturnType<typeof createServiceClient>,
  turns: Anthropic.MessageParam[]
): Promise<void> {
  for (const turn of turns) {
    const direction = turn.role === 'assistant' ? 'outbound' : 'inbound'
    await supabase.from('caye_admin_shell_messages').insert({
      direction,
      body: summarizeTurnBody(turn),
      claude_format: turn,
    })
  }
}
