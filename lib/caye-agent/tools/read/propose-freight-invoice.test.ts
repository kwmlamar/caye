import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { HIGH_RISK_TOOLS } from '../high-risk-registry'
import { findTool } from '../registry'

/**
 * The freight/estimate-to-invoice path had no agent tool at all: every part of
 * it was reachable only from the founder dashboard route, so Caye could not
 * investigate a freight request herself. These assertions pin the shape of the
 * tool that closes that gap — specifically that closing it did not also hand
 * the model a way to create or send a money document.
 */
describe('propose_freight_invoice — registration', () => {
  it('is registered exactly once', () => {
    expect(findTool('propose_freight_invoice')?.name).toBe('propose_freight_invoice')
  })

  it('is read-only, back-office, owner/founder only', () => {
    const tool = findTool('propose_freight_invoice')
    expect(tool?.risk).toBe('read')
    expect(tool?.modes).toEqual(['back-office'])
    expect(tool?.roles).toEqual(['owner', 'founder'])
  })

  it('is not a confirmable action — it proposes, it does not execute', () => {
    expect(HIGH_RISK_TOOLS.some((tool) => tool.name === 'propose_freight_invoice')).toBe(false)
    expect(findTool('propose_freight_invoice')?.terminatesTurn).toBeUndefined()
  })

  it('requires the conversation it is proposing from', () => {
    const schema = findTool('propose_freight_invoice')?.inputSchema as { required?: string[] }
    expect(schema.required).toEqual(['conversation_id'])
  })

  it('describes itself to the model without promising to send anything', () => {
    const description = findTool('propose_freight_invoice')?.description ?? ''
    expect(description).toContain('does not create or send anything')
  })
})
