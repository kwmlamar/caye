import type Anthropic from '@anthropic-ai/sdk'
import type { RichResult } from '@/lib/caye-direct-rich-results'

export function engineeringProjectRichResultFromTurns(turns: readonly Anthropic.MessageParam[]): RichResult | undefined {
  const successfulToolUseIds = new Set<string>()
  for (const turn of turns) {
    if (turn.role !== 'user' || typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type === 'tool_result' && block.is_error !== true) successfulToolUseIds.add(block.tool_use_id)
    }
  }
  const ids: string[] = []
  for (const turn of turns) {
    if (turn.role !== 'assistant' || typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type !== 'tool_use' || block.name !== 'get_engineering_project' || !successfulToolUseIds.has(block.id)) continue
      const input = block.input
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const projectId = (input as Record<string, unknown>).project_id
      if (typeof projectId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) ids.push(projectId)
    }
  }
  const unique = [...new Set(ids)]
  if (unique.length === 0) return undefined
  return { version: 1, narrative: '', blocks: unique.map((projectId) => ({ type: 'engineering_project' as const, projectId })) }
}
