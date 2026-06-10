import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loadOperatorContext } from './context'
import { buildBackOfficeSystemPrompt } from './modes/back-office'

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 800

export type CayeAgentMode = 'front-desk' | 'back-office'

export interface CayeAgentInput {
  mode: CayeAgentMode
  workspaceId: string
  userMessage: string
}

export interface CayeAgentResult {
  /** Plain-text reply, ready to send to WhatsApp. Empty string if nothing useful was produced. */
  replyText: string
  /**
   * The assistant turn we should persist on `caye_operator_messages.claude_format`
   * so the next sliding-window load reconstructs the full Claude history.
   */
  assistantTurn: Anthropic.MessageParam
}

/**
 * Entry point for the unified Caye agent (epic #35).
 *
 * Slice 1 scope (this file):
 *   - mode: 'back-office' only
 *   - No tools — the agent just chats with the operator using the
 *     back-office prompt + sliding window of prior turns.
 *   - Tool execution + risk-tiered confirmation flow arrive in slices
 *     2-6.
 *
 * Front-desk mode stays on lib/caye-reply.ts for now. The mode arg is
 * here to lock the API shape so future refactors don't have to migrate
 * call sites.
 */
export async function cayeAgent(input: CayeAgentInput): Promise<CayeAgentResult> {
  if (input.mode !== 'back-office') {
    throw new Error(
      `[caye-agent] mode '${input.mode}' is not yet routed through the unified agent (see epic #35).`
    )
  }

  const supabase = createServiceClient()

  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, full_name')
    .eq('id', input.workspaceId)
    .maybeSingle()

  const systemPrompt = buildBackOfficeSystemPrompt({
    businessName: (customer?.business_name as string | null) ?? null,
    operatorName: (customer?.full_name as string | null) ?? null,
  })

  const history = await loadOperatorContext(input.workspaceId)

  // The user turn for THIS message — caller is responsible for also
  // persisting it to caye_operator_messages with `claude_format` set
  // to { role: 'user', content: input.userMessage }.
  const currentUserTurn: Anthropic.MessageParam = {
    role: 'user',
    content: input.userMessage,
  }

  const messages: Anthropic.MessageParam[] = [...history, currentUserTurn]

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages,
  })

  const replyText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

  const assistantTurn: Anthropic.MessageParam = {
    role: 'assistant',
    content: response.content,
  }

  return { replyText, assistantTurn }
}

// Re-exports for downstream callers.
export { loadOperatorContext } from './context'
export { buildBackOfficeSystemPrompt } from './modes/back-office'
