import { describe, expect, it } from 'vitest'
import { reconcileAmounts } from './reconcile'

describe('invoice amount reconciliation', () => {
  it('balances when the lines, tax and shipping agree with the stated total', () => {
    const result = reconcileAmounts({ lineTotals: [370, 127.5], subtotal: 497.5, tax: 0, shipping: 25, total: 522.5 })
    expect(result.linesTotal).toBe(497.5)
    expect(result.computedTotal).toBe(522.5)
    expect(result.totalVariance).toBe(0)
    expect(result.balanced).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('does not accumulate floating point error across many lines', () => {
    const result = reconcileAmounts({ lineTotals: Array.from({ length: 10 }, () => 0.1), subtotal: 1, tax: null, shipping: null, total: 1 })
    expect(result.linesTotal).toBe(1)
    expect(result.balanced).toBe(true)
  })

  it('reports a stated total that disagrees with the lines rather than trusting it', () => {
    const result = reconcileAmounts({ lineTotals: [370, 127.5], subtotal: 497.5, tax: 0, shipping: 25, total: 600 })
    expect(result.balanced).toBe(false)
    expect(result.totalVariance).toBe(77.5)
    expect(result.issues.join(' ')).toContain('states a total of 600')
  })

  it('reports a stated subtotal that disagrees with the lines', () => {
    const result = reconcileAmounts({ lineTotals: [370, 127.5], subtotal: 400, tax: 0, shipping: 25, total: 425 })
    expect(result.subtotalVariance).toBe(-97.5)
    expect(result.balanced).toBe(false)
    expect(result.issues.join(' ')).toContain('states a subtotal of 400')
  })

  it('cannot balance when any line has no established amount', () => {
    const result = reconcileAmounts({ lineTotals: [370, null], subtotal: null, tax: null, shipping: null, total: 497.5 })
    expect(result.linesTotal).toBeNull()
    expect(result.computedTotal).toBeNull()
    expect(result.unpricedLineCount).toBe(1)
    expect(result.balanced).toBe(false)
    expect(result.issues.join(' ')).toContain('One item has no established amount')
  })

  it('cannot balance when there is no stated total to check against', () => {
    const result = reconcileAmounts({ lineTotals: [370], subtotal: null, tax: null, shipping: null, total: null })
    expect(result.balanced).toBe(false)
    expect(result.issues.join(' ')).toContain('states no total')
  })

  it('records tax and shipping that were assumed to be zero', () => {
    const result = reconcileAmounts({ lineTotals: [100], subtotal: null, tax: null, shipping: null, total: 100 })
    expect(result.assumedZero).toEqual(['tax', 'shipping'])
    expect(result.balanced).toBe(true)
  })

  it('tolerates a one-cent rounding difference but not two', () => {
    expect(reconcileAmounts({ lineTotals: [100], subtotal: null, tax: null, shipping: null, total: 100.01 }).balanced).toBe(true)
    expect(reconcileAmounts({ lineTotals: [100], subtotal: null, tax: null, shipping: null, total: 100.02 }).balanced).toBe(false)
  })

  it('treats zero lines as unbalanced rather than trivially correct', () => {
    const result = reconcileAmounts({ lineTotals: [], subtotal: null, tax: null, shipping: null, total: 0 })
    expect(result.balanced).toBe(false)
    expect(result.issues.join(' ')).toContain('No priced items')
  })
})
