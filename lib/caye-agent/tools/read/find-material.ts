import 'server-only'
import type { BedrockAdapter, BedrockMaterialCandidate } from '@/lib/domain-adapters/bedrock'

/**
 * Adapter surface materials-matching needs -- a narrow Pick, same reasoning
 * as `JobSearchAdapter` in find-job.ts: a test can inject a one-method fake
 * instead of standing up the whole class.
 */
export type MaterialSearchAdapter = Pick<BedrockAdapter, 'listMaterials'>

export interface MaterialResolution {
  match: 'none' | 'one' | 'many'
  count: number
  candidates: BedrockMaterialCandidate[]
}

// Same filler-word stripping as find-job.ts, tuned for receipt line-item text
// rather than WhatsApp job phrasing -- "a bag of", "box of", "each" carry no
// identifying signal and would otherwise force every query token to survive
// only by accident.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'for', 'with', 'box', 'bag', 'each', 'per', 'pc', 'pcs',
])

function significantTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
  if (tokens.length > 0) return tokens
  const fallback = query.trim().toLowerCase()
  return fallback ? [fallback] : []
}

/**
 * Resolve a receipt line item's free-text description ("123 PRIMER INT/EX",
 * "BC plywood 3/8 sheet") to zero, one, or several existing `materials`
 * catalog rows.
 *
 * Mirrors `resolveJob`'s shape and its refusal rule exactly: every
 * significant token in the query must appear somewhere in the combined
 * name/category/supplier text, and more than one surviving candidate is
 * reported as ambiguous rather than picked from -- linking a line item to
 * the wrong catalog entry corrupts that entry's cost history the same way
 * attributing hours to the wrong job corrupts labor cost, so an ambiguous
 * match is a hard stop here too, not a best-guess.
 */
export async function resolveMaterial(
  adapter: MaterialSearchAdapter,
  workspaceId: string,
  query: string,
): Promise<MaterialResolution> {
  const tokens = significantTokens(query)
  if (tokens.length === 0) return { match: 'none', count: 0, candidates: [] }

  const rows = await adapter.listMaterials(workspaceId, { limit: 500 })

  const candidates = rows.filter(material => {
    const haystack = `${material.name} ${material.category ?? ''} ${material.supplier ?? ''}`.toLowerCase()
    return tokens.every(t => haystack.includes(t))
  })

  if (candidates.length === 0) return { match: 'none', count: 0, candidates: [] }
  if (candidates.length === 1) return { match: 'one', count: 1, candidates }
  return { match: 'many', count: candidates.length, candidates }
}
