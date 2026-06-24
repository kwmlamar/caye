import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOL_REGISTRY, findTool } from './tools/registry'
import { asAnthropicTool, type ToolContext } from './tools/types'

// Safety: bound the tool loop so a misbehaving model can't call tools
// forever. 5 iterations is generous — most operator asks resolve in 1-2.
const MAX_TOOL_ITERATIONS = 5

export interface ToolLoopArgs {
  client: Anthropic
  model: string
  maxTokens: number
  systemPrompt: string
  initialMessages: Anthropic.MessageParam[]
  ctx: ToolContext
}

export interface ToolLoopResult {
  /** The final user-facing text reply (joined text blocks of the last assistant turn). */
  replyText: string
  /**
   * All turns produced during the loop, in order. Caller persists each
   * to `caye_operator_messages.claude_format` so the sliding window
   * sees them on the next inbound message.
   */
  newTurns: Anthropic.MessageParam[]
}

/**
 * Run a Claude tool-use loop against the registered back-office tools.
 *
 * Loop semantics:
 *   1. Send messages to Claude with the tool list.
 *   2. If Claude responds with tool_use blocks, execute each tool, build
 *      a user turn of tool_result blocks, push, and continue.
 *   3. If Claude responds with text only (no tool_use), we're done.
 *
 * Risk gating note (slice #38): all tools currently registered are
 * `risk: 'read'`. Low-risk and high-risk tools are sliced in #37 and
 * #42; the confirmation flow for high-risk lives in #42's execute path.
 * For now every tool just executes — the risk field is data we'll use
 * later, not behavior here.
 */
export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  // Cache breakpoint on the last tool caches the entire tools array.
  // The back-office system prompt is workspace-stable (operator profile
  // and voice profile only change on owner edits), so the system block
  // is cached at 1h TTL alongside the tools. Locked 2026-06-24 (#46) —
  // previously this path shipped zero caching (raw string system, no
  // tool cache_control), giving ~0% cache reads on the back-office surface.
  const tools = TOOL_REGISTRY.map(asAnthropicTool)
  if (tools.length > 0) {
    const last = tools[tools.length - 1]
    tools[tools.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    } as Anthropic.Tool
  }
  const messages: Anthropic.MessageParam[] = [...args.initialMessages]
  const newTurns: Anthropic.MessageParam[] = []

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await args.client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      system: [
        {
          type: 'text',
          text: args.systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages,
      tools,
    })

    const assistantTurn: Anthropic.MessageParam = {
      role: 'assistant',
      content: response.content,
    }
    messages.push(assistantTurn)
    newTurns.push(assistantTurn)

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0) {
      // Claude is done. Pull text out of the final turn.
      const replyText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      return { replyText, newTurns }
    }

    // Execute each tool, append tool_result blocks as a single user turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      const tool = findTool(block.name)
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error: `Unknown tool: ${block.name}`,
          }),
          is_error: true,
        })
        continue
      }
      try {
        const result = await tool.execute(block.input as never, args.ctx)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `[caye-agent/execute] tool ${block.name} threw:`,
          msg
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ ok: false, error: msg }),
          is_error: true,
        })
      }
    }

    const toolResultTurn: Anthropic.MessageParam = {
      role: 'user',
      content: toolResults,
    }
    messages.push(toolResultTurn)
    newTurns.push(toolResultTurn)
  }

  throw new Error(
    `[caye-agent/execute] tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations`
  )
}
