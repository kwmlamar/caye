import 'server-only'

import { founderCapabilityManifest } from './gateway'
import type { CapabilityManifestEntry, CapabilityName } from './types'

export type CapabilityApprovalRequirement = 'none' | 'explicit_confirmation' | 'unavailable'
export type CapabilityScopeMode = 'workspace' | 'operator' | 'either' | 'canonical_entity'
export type CapabilityDomain =
  | 'business_operations'
  | 'communications'
  | 'research'
  | 'engineering'
  | 'properties'
  | 'perception'
  | 'computers'
  | 'iot'
  | 'sensors'
  | 'robots_machines'

export type ConversationalCapabilityDescriptor = CapabilityManifestEntry & {
  approvalRequirement: CapabilityApprovalRequirement
  scopeMode: CapabilityScopeMode
  domain: CapabilityDomain
  available: boolean
  unavailableReason: string | null
}

const OPERATOR_SCOPED_NAMESPACES = new Set(['job_search', 'research'])
const CANONICAL_ENTITY_SCOPED = new Set<CapabilityName>(['property.snapshot'])
const EITHER_SCOPED = new Set<CapabilityName>(['goals.list'])

function domainFor(manifest: CapabilityManifestEntry): CapabilityDomain {
  switch (manifest.namespace) {
    case 'research':
      return 'research'
    case 'engineering':
      return 'engineering'
    case 'property':
      return 'properties'
    case 'perception':
      return 'perception'
    case 'attention':
    case 'goals':
    case 'growth':
    case 'job_search':
    case 'context':
    case 'artifacts':
    default:
      return 'business_operations'
  }
}

function approvalFor(manifest: CapabilityManifestEntry): CapabilityApprovalRequirement {
  if (manifest.access === 'read') return 'none'
  if (manifest.risk === 'low') return 'none'
  return 'explicit_confirmation'
}

function scopeModeFor(manifest: CapabilityManifestEntry): CapabilityScopeMode {
  if (CANONICAL_ENTITY_SCOPED.has(manifest.name)) return 'canonical_entity'
  if (EITHER_SCOPED.has(manifest.name)) return 'either'
  if (OPERATOR_SCOPED_NAMESPACES.has(manifest.namespace)) return 'operator'
  return 'workspace'
}

export function conversationalCapabilityManifest(): ConversationalCapabilityDescriptor[] {
  return founderCapabilityManifest().map((manifest) => ({
    ...manifest,
    approvalRequirement: approvalFor(manifest),
    scopeMode: scopeModeFor(manifest),
    domain: domainFor(manifest),
    available: true,
    unavailableReason: null,
  }))
}

export type CapabilityCoverage = {
  domain: CapabilityDomain
  status: 'active' | 'limited' | 'future'
  capabilityCount: number
  readCount: number
  writeCount: number
  capabilities: CapabilityName[]
  gap: string | null
}

const FUTURE_GAPS: Array<{ domain: CapabilityDomain; gap: string }> = [
  { domain: 'communications', gap: 'Conversation tools exist, but no canonical model-facing capability is registered yet.' },
  { domain: 'computers', gap: 'No authorized computer-control capability is registered.' },
  { domain: 'iot', gap: 'No authorized IoT control capability is registered.' },
  { domain: 'sensors', gap: 'No authorized sensor capability is registered.' },
  { domain: 'robots_machines', gap: 'No authorized robot or machine-control capability is registered.' },
]

export function capabilityCoverage(): CapabilityCoverage[] {
  const descriptors = conversationalCapabilityManifest()
  const domains: CapabilityDomain[] = [
    'business_operations',
    'communications',
    'research',
    'engineering',
    'properties',
    'perception',
    'computers',
    'iot',
    'sensors',
    'robots_machines',
  ]

  return domains.map((domain) => {
    const entries = descriptors.filter((entry) => entry.domain === domain)
    const gap = FUTURE_GAPS.find((entry) => entry.domain === domain)?.gap ?? null
    const capabilityCount = entries.length
    const readCount = entries.filter((entry) => entry.access === 'read').length
    const writeCount = entries.filter((entry) => entry.access === 'write').length
    const status: CapabilityCoverage['status'] = capabilityCount === 0 ? 'future' : gap ? 'limited' : 'active'
    return {
      domain,
      status,
      capabilityCount,
      readCount,
      writeCount,
      capabilities: entries.map((entry) => entry.name),
      gap,
    }
  })
}
