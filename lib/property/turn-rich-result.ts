import type Anthropic from '@anthropic-ai/sdk'
import type { RichResult } from '@/lib/caye-direct-rich-results'

/**
 * Derives property-card presentation only from a real, successful structured
 * get_property_snapshot execution. A model merely requesting the tool is not
 * enough: the matching tool_result must exist and must not be marked is_error.
 * This keeps the UI from implying the model saw property state when the lookup
 * actually failed.
 *
 * The renderer still re-fetches the id through founder auth + workspace scope,
 * so this is presentation provenance, not a second source of property truth.
 */
export function propertyRichResultFromTurns(turns: readonly Anthropic.MessageParam[]): RichResult | undefined {
  const successfulToolUseIds = new Set<string>()
  for (const turn of turns) {
    if (turn.role !== 'user' || typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type === 'tool_result' && block.is_error !== true) {
        successfulToolUseIds.add(block.tool_use_id)
      }
    }
  }

  const ids: string[] = []
  for (const turn of turns) {
    if (turn.role !== 'assistant' || typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (
        block.type !== 'tool_use' ||
        block.name !== 'get_property_snapshot' ||
        !successfulToolUseIds.has(block.id)
      ) continue
      const input = block.input
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const propertyId = (input as Record<string, unknown>).property_id
      if (typeof propertyId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(propertyId)) ids.push(propertyId)
    }
  }

  const unique = [...new Set(ids)]
  if (unique.length === 0) return undefined
  return {
    version: 1,
    narrative: '',
    blocks: unique.map((propertyId) => ({ type: 'property_snapshot' as const, propertyId })),
  }
}
