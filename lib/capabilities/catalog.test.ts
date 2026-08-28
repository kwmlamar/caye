import { describe, expect, it } from 'vitest'
import { cayeCapabilityRegistry } from './catalog'
import { capabilityManifest, getRegisteredCapability } from './registry'

describe('Caye capability catalog', () => {
  it('exposes the initial read-only semantic surface', () => {
    expect(capabilityManifest(cayeCapabilityRegistry)).toEqual([
      expect.objectContaining({ name: 'attention.list', access: 'read', risk: 'read_only' }),
      expect.objectContaining({ name: 'goals.list', access: 'read', risk: 'read_only' }),
    ])
  })

  it('keeps execution handlers private to the server registry', () => {
    const publicManifest = capabilityManifest(cayeCapabilityRegistry)
    expect(publicManifest.every((entry) => !('execute' in entry))).toBe(true)
    expect(getRegisteredCapability(cayeCapabilityRegistry, 'goals.list')?.execute).toBeTypeOf('function')
  })
})
