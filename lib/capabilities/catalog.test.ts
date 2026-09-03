import { describe, expect, it } from 'vitest'
import { cayeCapabilityRegistry } from './catalog'
import { capabilityManifest, getRegisteredCapability } from './registry'

describe('Caye capability catalog', () => {
  it('exposes the bounded semantic surface including staged research enqueue', () => {
    // Catalog has grown since this test was written: engineering.decision.analyze,
    // growth.snapshot, perception.status, research.investigate, and research.strategic
    // are all deliberate later additions to cayeCapabilityRegistry (see catalog.ts).
    // capabilityManifest() sorts by name, so this list must stay alphabetical.
    expect(capabilityManifest(cayeCapabilityRegistry)).toEqual([
      expect.objectContaining({ name: 'attention.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'engineering.artifacts.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'engineering.decision.analyze', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'goals.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'growth.snapshot', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'job_search.queue.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'job_search.summary', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'perception.status', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'property.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'property.snapshot', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'research.brief', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'research.claims', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'research.investigate', access: 'write', risk: 'low' }),
      expect.objectContaining({ name: 'research.start', access: 'write', risk: 'low' }),
      expect.objectContaining({ name: 'research.status', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'research.strategic', access: 'read', risk: 'read_only' }),
    ])
  })

  it('keeps execution handlers private to the server registry', () => {
    const publicManifest = capabilityManifest(cayeCapabilityRegistry)
    expect(publicManifest.every((entry) => !('execute' in entry))).toBe(true)
    expect(getRegisteredCapability(cayeCapabilityRegistry, 'goals.list')?.execute).toBeTypeOf('function')
  })
})
