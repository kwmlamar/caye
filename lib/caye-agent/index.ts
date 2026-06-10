import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loadOperatorContext } from './context'
import { buildBackOfficeSystemPrompt } from './modes/back-office'
import { runToolLoop } from './execute'

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 1024

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
   * All new turns produced this round (intermediate assistant turns with
   * tool_use, intermediate user turns with tool_result, and the final
   * assistant text turn). Caller persists each to
   * `caye_operator_messages.claude_format` so the next sliding-window
   * load reconstructs the full Claude history.
   */
  newTurns: Anthropic.MessageParam[]
}

/**
 * Entry point for the unified Caye agent (epic #35).
 *
 * Slice #38 scope (this file):
 *   - mode: 'back-office' only
 *   - Tool-use loop with the read tools registered in tools/registry.ts
 *   - Sliding window context from caye_operator_messages
 *   - Returns every turn for the webhook to persist individually
 *
 * Front-desk mode still routes through lib/caye-reply.ts; the mode arg
 * is here to lock the API shape for later refactors.
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
  const currentUserTurn: Anthropic.MessageParam = {
    role: 'user',
    content: input.userMessage,
  }
  const initialMessages: Anthropic.MessageParam[] = [...history, currentUserTurn]

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { replyText, newTurns } = await runToolLoop({
    client,
    model: MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    systemPrompt,
    initialMessages,
    ctx: { workspaceId: input.workspaceId },
  })

  return { replyText, newTurns }
}

export { loadOperatorContext } from './context'
export { buildBackOfficeSystemPrompt } from './modes/back-office'
