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
const CONVERSATIONAL_WRITE_ADAPTERS = new Set<CapabilityName>(['research.start'])

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

function conversationalAvailability(manifest: CapabilityManifestEntry): {
  available: boolean
  unavailableReason: string | null
} {
  if (manifest.access === 'read') return { available: true, unavailableReason: null }
  if (CONVERSATIONAL_WRITE_ADAPTERS.has(manifest.name)) return { available: true, unavailableReason: null }
  return {
    available: false,
    unavailableReason: 'Canonical capability is registered, but no model-facing conversational adapter is exposed yet.',
  }
}

export function conversationalCapabilityManifest(): ConversationalCapabilityDescriptor[] {
  return founderCapabilityManifest().map((manifest) => ({
    ...manifest,
    approvalRequirement: approvalFor(manifest),
    scopeMode: scopeModeFor(manifest),
    domain: domainFor(manifest),
    ...conversationalAvailability(manifest),
  }))
}

export type CapabilityCoverage = {
  domain: CapabilityDomain
  status: 'active' | 'limited' | 'future'
  capabilityCount: number
  registeredCapabilityCount: number
  unavailableCapabilityCount: number
  readCount: number
  writeCount: number
  capabilities: CapabilityName[]
  unavailableCapabilities: CapabilityName[]
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
    const registered = descriptors.filter((entry) => entry.domain === domain)
    const entries = registered.filter((entry) => entry.available)
    const unavailable = registered.filter((entry) => !entry.available)
    const declaredGap = FUTURE_GAPS.find((entry) => entry.domain === domain)?.gap ?? null
    const adapterGap = unavailable.length > 0
      ? `${unavailable.length} registered canonical capability${unavailable.length === 1 ? '' : 'ies'} still lack${unavailable.length === 1 ? 's' : ''} a conversational adapter.`
      : null
    const gap = [declaredGap, adapterGap].filter(Boolean).join(' ') || null
    const capabilityCount = entries.length
    const readCount = entries.filter((entry) => entry.access === 'read').length
    const writeCount = entries.filter((entry) => entry.access === 'write').length
    const status: CapabilityCoverage['status'] =
      capabilityCount === 0 && registered.length === 0 ? 'future' : gap ? 'limited' : 'active'
    return {
      domain,
      status,
      capabilityCount,
      registeredCapabilityCount: registered.length,
      unavailableCapabilityCount: unavailable.length,
      readCount,
      writeCount,
      capabilities: entries.map((entry) => entry.name),
      unavailableCapabilities: unavailable.map((entry) => entry.name),
      gap,
    }
  })
}
