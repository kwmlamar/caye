import type { BedrockEstimate } from '@/lib/domain-adapters/bedrock/types'
import type { EstimateBasis } from './types'

/**
 * The estimate side of estimate-to-invoice.
 *
 * Bedrock is authoritative for what was estimated; Caye's artifacts are
 * authoritative for what was actually purchased. Nothing in the repository
 * joined the two, so an invoice proposal had no way to say "this line is the
 * concrete we estimated" as opposed to "this line is a number off a receipt."
 *
 * The join is intentionally conservative: a single unambiguous match, or none.
 * A wrong basis on a money document is worse than an absent one.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'per', 'each', 'set', 'pack', 'box', 'unit',
  'units', 'item', 'items', 'misc', 'other', 'assorted', 'various',
])

function tokens(value: string | null): string[] {
  if (!value) return []
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )]
}

export type EstimateLineRef = EstimateBasis

export function flattenEstimateLines(estimate: BedrockEstimate): EstimateLineRef[] {
  return estimate.sections.flatMap((section) =>
    section.lineItems.map((lineItem) => ({
      estimateId: estimate.id,
      estimateNumber: estimate.number,
      sectionId: section.id,
      sectionName: section.name,
      lineItemId: lineItem.id,
      lineItemDescription: lineItem.description,
      estimatedQuantity: lineItem.quantity,
      estimatedAmount: lineItem.totalAmount,
    })),
  )
}

export interface EstimateMatch {
  basis: EstimateLineRef | null
  /** True when two or more estimate lines tied for the best score. */
  ambiguous: boolean
}

/**
 * Match one purchased description against the estimate's line items by shared
 * significant tokens. Ties resolve to no basis rather than to a guess.
 */
export function matchEstimateLine(description: string | null, candidates: EstimateLineRef[]): EstimateMatch {
  const wanted = tokens(description)
  if (wanted.length === 0 || candidates.length === 0) return { basis: null, ambiguous: false }

  let best: EstimateLineRef | null = null
  let bestScore = 0
  let tied = false

  for (const candidate of candidates) {
    const available = tokens(candidate.lineItemDescription)
    const score = wanted.filter((token) => available.includes(token)).length
    if (score === 0) continue
    if (score > bestScore) {
      best = candidate
      bestScore = score
      tied = false
    } else if (score === bestScore && best && candidate.lineItemId !== best.lineItemId) {
      tied = true
    }
  }

  if (!best || bestScore === 0) return { basis: null, ambiguous: false }
  if (tied) return { basis: null, ambiguous: true }
  return { basis: best, ambiguous: false }
}
