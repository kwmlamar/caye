import { describe, expect, it } from 'vitest'
import { hasSalesCapability, resolveSalesCapability } from './capability'

describe('Sales capability resolver', () => {
  it('resolves acquisition only for the internal Sales workspace', () => {
    expect(resolveSalesCapability({ workspace_kind: 'internal_sales' })?.kind).toBe('sales_acquisition')
    expect(hasSalesCapability({ workspace_kind: 'service_business' })).toBe(false)
    expect(resolveSalesCapability(null)).toBeNull()
  })
})
