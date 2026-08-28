import type Anthropic from '@anthropic-ai/sdk'
import type { RichResult } from '@/lib/caye-direct-rich-results'
import { mergeRichResults } from '@/lib/artifacts/rich-result'
import { engineeringProjectRichResultFromTurns } from '@/lib/engineering-projects/turn-rich-result'

/**
 * Derives server-authoritative property/project presentation only from real,
 * successful structured tool executions. A matching non-error tool_result is
 * required; model-authored rich JSON cannot create either trusted block.
 *
 * This remains the existing Direct orchestration hook so both the production
 * investigation path and model-router path get identical physical-world rich
 * result semantics without adding another branch to founder-thread-turn.ts.
 */
export function propertyRichResultFromTurns(turns: readonly Anthropic.MessageParam[]): RichResult | undefined {
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
      if (block.type !== 'tool_use' || block.name !== 'get_property_snapshot' || !successfulToolUseIds.has(block.id)) continue
      const input = block.input
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const propertyId = (input as Record<string, unknown>).property_id
      if (typeof propertyId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(propertyId)) ids.push(propertyId)
    }
  }

  const unique = [...new Set(ids)]
  const propertyResult: RichResult | undefined = unique.length === 0 ? undefined : {
    version: 1,
    narrative: '',
    blocks: unique.map((propertyId) => ({ type: 'property_snapshot' as const, propertyId })),
  }
  return mergeRichResults(propertyResult, engineeringProjectRichResultFromTurns(turns))
}
