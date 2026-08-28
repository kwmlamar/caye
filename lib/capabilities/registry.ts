import 'server-only'
import type {
  CapabilityManifestEntry,
  CapabilityName,
  RegisteredCapability,
} from './types'

export type CapabilityRegistry = ReadonlyMap<CapabilityName, RegisteredCapability>

/**
 * Build an allowlisted registry. Duplicate semantic names are rejected so callers
 * can never depend on insertion order to determine which implementation executes.
 */
export function createCapabilityRegistry(
  capabilities: readonly RegisteredCapability[],
): CapabilityRegistry {
  const registry = new Map<CapabilityName, RegisteredCapability>()

  for (const capability of capabilities) {
    const { name } = capability.manifest
    if (registry.has(name)) {
      throw new Error(`Duplicate Caye capability registration: ${name}`)
    }
    registry.set(name, capability)
  }

  return registry
}

/**
 * Only the semantic manifest is exposed to reasoning layers. Execution handlers
 * stay server-side and database/storage implementation details never cross this
 * boundary.
 */
export function capabilityManifest(registry: CapabilityRegistry): CapabilityManifestEntry[] {
  return [...registry.values()]
    .map(({ manifest }) => ({ ...manifest }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getRegisteredCapability(
  registry: CapabilityRegistry,
  name: CapabilityName,
): RegisteredCapability | null {
  return registry.get(name) ?? null
}
