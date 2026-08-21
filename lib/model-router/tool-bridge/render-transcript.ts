import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Projects Caye's canonical Anthropic.MessageParam[] history into a flat,
 * readable transcript for a CLI backend's prompt. Lossy by design — this
 * text is never persisted and never read back; the canonical
 * Anthropic.MessageParam[] array (built by founder-tool-loop.ts from real
 * ContentBlocks, same as runToolLoop) remains the source of truth for
 * storage and replay. Only this rendering is backend-specific.
 *
 * Deliberately does NOT use a "SYSTEM:" label anywhere — validated live
 * against the installed Claude Code CLI (2026-08-16): a prior version of
 * this prompt that opened with an in-band "SYSTEM:" block was correctly
 * flagged and refused as a prompt-injection attempt by Claude Code's own
 * safety layer, since role labels inside user/stdin content aren't a
 * trustworthy way to claim system authority. The real system prompt goes
 * through the CLI's own --system-prompt flag (claude-subscription.ts);
 * this function only ever renders conversation history, framed plainly as
 * history, which tested clean.
 *
 * Tool-result rendering hardened 2026-08-16 after a real, reproducible
 * finding: a plain "TOOL RESULT for call X: ..." string is trivial for a
 * model to imitate, and Claude did exactly that — wrote its own fake "TOOL
 * RESULT:" lines inside a fabricated final answer (see
 * fixtures/fabricated-tool-transcripts.ts). Genuine results are now
 * rendered with a CAYE_RUNTIME_TOOL_RESULT marker plus an execution_id
 * (the same synthetic tool_use_id a backend only ever assigns in response
 * to a real parsed request — never model-authored), and the protocol
 * instructions (claude-subscription.ts / openai-codex-subscription.ts)
 * both tell the model this marker exists specifically so it can recognize
 * genuine results and are told never to produce it themselves. That
 * makes ANY occurrence of the marker in a model's own final text a
 * reliable protocol-violation signal — see protocol-artifact-guard.ts.
 */
export function renderTranscriptForCli(messages: readonly Anthropic.MessageParam[]): string {
  const lines: string[] = ['Conversation so far:', '']
  const toolNameByUseId = new Map<string, string>()
  for (const message of messages) {
    lines.push(...renderMessage(message, toolNameByUseId))
  }
  return lines.join('\n')
}

function renderMessage(message: Anthropic.MessageParam, toolNameByUseId: Map<string, string>): string[] {
  const content = message.content
  if (typeof content === 'string') {
    return [`${roleLabel(message.role)}: ${content}`, '']
  }

  const out: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      out.push(`${roleLabel(message.role)}: ${block.text}`)
    } else if (block.type === 'tool_use') {
      toolNameByUseId.set(block.id, block.name)
      out.push(`${roleLabel(message.role)}: [Requested tool \`${block.name}\` with input ${JSON.stringify(block.input)}]`)
    } else if (block.type === 'tool_result') {
      const toolUseId = 'tool_use_id' in block ? block.tool_use_id : 'unknown'
      const toolName = toolNameByUseId.get(toolUseId) ?? 'unknown'
      const status = block.is_error ? 'error' : 'success'
      out.push(`CAYE_RUNTIME_TOOL_RESULT execution_id=${toolUseId} tool=${toolName} status=${status}`)
      out.push(stringifyToolResultContent(block.content))
    } else if (block.type === 'image') {
      out.push(`${roleLabel(message.role)}: [image attachment omitted]`)
    }
  }
  out.push('')
  return out
}

function stringifyToolResultContent(content: Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
      .join(' ')
  }
  return JSON.stringify(content)
}

function roleLabel(role: Anthropic.MessageParam['role']): string {
  return role === 'assistant' ? 'ASSISTANT' : 'USER'
}
