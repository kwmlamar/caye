import type Anthropic from '@anthropic-ai/sdk'
import type { RichResult } from '@/lib/caye-direct-rich-results'

/**
 * Derives property-card presentation from real structured tool_use blocks that
 * already passed through Caye's tool loop. This keeps the default Direct path
 * independent of model-authored rich-result JSON: if Caye actually looked up a
 * property snapshot, the UI can render that property. A guessed id in prose is
 * not enough.
 *
 * The renderer still re-fetches the id through founder auth + workspace scope,
 * so this is presentation provenance, not a second source of property truth.
 */
export function propertyRichResultFromTurns(turns: readonly Anthropic.MessageParam[]): RichResult | undefined {
  const ids: string[] = []

  for (const turn of turns) {
    if (turn.role !== 'assistant' || typeof turn.content === 'string') continue
    for (const block of turn.content) {
      if (block.type !== 'tool_use' || block.name !== 'get_property_snapshot') continue
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
