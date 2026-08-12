import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { buildComplianceFooter, buildTrackedDemoLink, buildUnsubscribeLink } = await import('./outreach-compliance')

describe('buildComplianceFooter', () => {
  it('includes a real mailing address, not the placeholder', () => {
    const footer = buildComplianceFooter('abc123')
    expect(footer).not.toMatch(/REPLACE BEFORE GOING LIVE/)
    expect(footer).toContain('Sheridan, WY')
  })

  it('includes an unsubscribe link built from the token', () => {
    const footer = buildComplianceFooter('abc123')
    expect(footer).toContain(buildUnsubscribeLink('abc123'))
  })
})

describe('buildTrackedDemoLink / buildUnsubscribeLink', () => {
  it('point at different routes for the same token', () => {
    expect(buildTrackedDemoLink('tok')).toContain('/api/r/tok')
    expect(buildUnsubscribeLink('tok')).toContain('/api/unsubscribe/tok')
  })
})
