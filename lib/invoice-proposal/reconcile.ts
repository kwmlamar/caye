import type { ReconciliationResult } from './types'

/**
 * Money arithmetic in integer cents.
 *
 * The freight document this replaces printed a `TOTAL` straight from one
 * receipt without ever checking it against the lines above it. On an invoice
 * that is the difference between a document a business can stand behind and a
 * number nobody verified.
 */
const CENTS_TOLERANCE = 1

const toCents = (value: number): number => Math.round(value * 100)
const toAmount = (cents: number): number => Math.round(cents) / 100

export interface ReconcileInput {
  /** Per-line contribution. `null` marks a line whose value is not established. */
  lineTotals: Array<number | null>
  subtotal: number | null
  tax: number | null
  shipping: number | null
  total: number | null
}

/**
 * Deterministic reconciliation. Returns what agreed, what did not, and what
 * could not be checked at all — never a bare boolean.
 */
export function reconcileAmounts(input: ReconcileInput): ReconciliationResult {
  const unpricedLineCount = input.lineTotals.filter((value) => value === null).length
  const hasLines = input.lineTotals.length > 0
  const issues: string[] = []
  const assumedZero: Array<'tax' | 'shipping'> = []

  const linesTotalCents = unpricedLineCount === 0 && hasLines
    ? input.lineTotals.reduce<number>((sum, value) => sum + toCents(value as number), 0)
    : null
  const linesTotal = linesTotalCents === null ? null : toAmount(linesTotalCents)

  if (!hasLines) issues.push('No priced items were established from the purchase evidence.')
  else if (unpricedLineCount > 0) {
    issues.push(
      unpricedLineCount === 1
        ? 'One item has no established amount, so the totals cannot be checked.'
        : `${unpricedLineCount} items have no established amount, so the totals cannot be checked.`,
    )
  }

  if (input.tax === null) assumedZero.push('tax')
  if (input.shipping === null) assumedZero.push('shipping')

  const computedTotalCents = linesTotalCents === null
    ? null
    : linesTotalCents + toCents(input.tax ?? 0) + toCents(input.shipping ?? 0)
  const computedTotal = computedTotalCents === null ? null : toAmount(computedTotalCents)

  let subtotalVariance: number | null = null
  if (input.subtotal !== null && linesTotalCents !== null) {
    const varianceCents = toCents(input.subtotal) - linesTotalCents
    subtotalVariance = toAmount(varianceCents)
    if (Math.abs(varianceCents) > CENTS_TOLERANCE) {
      issues.push(`The item amounts add up to ${linesTotal}, but the purchase evidence states a subtotal of ${input.subtotal}.`)
    }
  }

  let totalVariance: number | null = null
  if (input.total !== null && computedTotalCents !== null) {
    const varianceCents = toCents(input.total) - computedTotalCents
    totalVariance = toAmount(varianceCents)
    if (Math.abs(varianceCents) > CENTS_TOLERANCE) {
      issues.push(`The items, tax and shipping add up to ${computedTotal}, but the purchase evidence states a total of ${input.total}.`)
    }
  } else if (input.total === null) {
    issues.push('The purchase evidence states no total to check the item amounts against.')
  }

  const balanced =
    hasLines &&
    unpricedLineCount === 0 &&
    input.total !== null &&
    totalVariance !== null &&
    Math.abs(toCents(totalVariance)) <= CENTS_TOLERANCE &&
    (subtotalVariance === null || Math.abs(toCents(subtotalVariance)) <= CENTS_TOLERANCE)

  return {
    linesTotal,
    unpricedLineCount,
    computedTotal,
    assumedZero,
    statedSubtotal: input.subtotal,
    statedTotal: input.total,
    subtotalVariance,
    totalVariance,
    balanced,
    issues,
  }
}
