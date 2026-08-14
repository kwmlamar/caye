import { describe, expect, it } from 'vitest'
import { isProductionSalesWorkspace } from './workspace-eligibility'

describe('production Sales workspace eligibility', () => {
  it('excludes demo and non-Sales workspaces from acquisition automation', () => {
    expect(isProductionSalesWorkspace({ workspace_kind: 'internal_sales', plan: 'demo' })).toBe(false)
    expect(isProductionSalesWorkspace({ workspace_kind: 'service_business', plan: 'pro' })).toBe(false)
    expect(isProductionSalesWorkspace({ workspace_kind: 'internal_sales', plan: 'pro' })).toBe(true)
  })
})
