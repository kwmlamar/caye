import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { HIGH_RISK_TOOLS } from './high-risk-registry'
import { TOOL_REGISTRY } from './registry'
import {
  EXTERNAL_DRAFT_INTENT_REQUIRED,
  verifyExternalDraftIntent,
} from './external-draft-intent'

describe('owner drafting stays inside the Caye conversation', () => {
  it('does not expose draft_in_inbox as a callable or confirmable tool', () => {
    expect(HIGH_RISK_TOOLS.map((tool) => tool.name)).not.toContain('draft_in_inbox')
    expect(TOOL_REGISTRY.map((tool) => tool.name)).not.toContain('draft_in_inbox')
  })

  it('fails closed if the retired compatibility wrapper is somehow reached', async () => {
    const result = await verifyExternalDraftIntent({
      workspaceId: 'ws-1',
      callerRole: 'owner',
      operatorId: 1,
      requestId: 'req-1',
    })
    expect(result.ok).toBe(false)
    expect(result.error_code).toBe(EXTERNAL_DRAFT_INTENT_REQUIRED)
    expect(result.error).toMatch(/retired/i)
    expect(result.error).toMatch(/current owner conversation/i)
  })
})
