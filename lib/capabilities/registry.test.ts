import { describe, expect, it } from 'vitest'
import { capabilityManifest, createCapabilityRegistry, getRegisteredCapability } from './registry'
import type { RegisteredCapability } from './types'

function readCapability(name: 'goals.list' | 'attention.list'): RegisteredCapability {
  const namespace = name.split('.')[0] as 'goals' | 'attention'
  return {
    manifest: {
      name,
      version: 1,
      namespace,
      description: `Read ${namespace}`,
      access: 'read',
      risk: 'read_only',
      inputSchemaId: `${name}.input.v1`,
      outputSchemaId: `${name}.output.v1`,
    },
    async execute() {
      return {
        status: 'observed',
        data: [],
        evidence: [],
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    },
  }
}

describe('Caye capability registry', () => {
  it('exposes only stable semantic manifest data in deterministic order', () => {
    const registry = createCapabilityRegistry([
      readCapability('goals.list'),
      readCapability('attention.list'),
    ])

    expect(capabilityManifest(registry).map((entry) => entry.name)).toEqual([
      'attention.list',
      'goals.list',
    ])
    expect(capabilityManifest(registry)[0]).not.toHaveProperty('execute')
  })

  it('rejects duplicate semantic registrations', () => {
    expect(() => createCapabilityRegistry([
      readCapability('goals.list'),
      readCapability('goals.list'),
    ])).toThrow('Duplicate Caye capability registration: goals.list')
  })

  it('returns null for capabilities outside the allowlisted registry', () => {
    const registry = createCapabilityRegistry([readCapability('goals.list')])
    expect(getRegisteredCapability(registry, 'property.get_current_state')).toBeNull()
  })
})
