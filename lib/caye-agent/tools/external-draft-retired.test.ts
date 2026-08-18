import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { HIGH_RISK_TOOLS } from './high-risk-registry'
import { TOOL_REGISTRY } from './registry'

describe('owner drafting stays inside the Caye conversation', () => {
  it('does not expose draft_in_inbox as a callable or confirmable tool', () => {
    expect(HIGH_RISK_TOOLS.map((tool) => tool.name)).not.toContain('draft_in_inbox')
    expect(TOOL_REGISTRY.map((tool) => tool.name)).not.toContain('draft_in_inbox')
  })
})
