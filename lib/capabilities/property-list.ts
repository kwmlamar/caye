import 'server-only'

import { listFounderProperties } from '@/lib/property/store'
import type { CapabilityResult, RegisteredCapability } from './types'

export type PropertyListItem = {
  /** Deliberate public selector: pass this to property.snapshot. Not workspace/auth scope. */
  id: string
  name: string
  locationLabel: string | null
}

function unavailable(): CapabilityResult<PropertyListItem[]> {
  return {
    status: 'failed',
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'unavailable', message: 'Property list could not be read.', retryable: true },
  }
}

/**
 * Founder-only property discovery (CAY-28 follow-up). Gives a fresh external
 * reasoning session a bounded way to find a property.snapshot selector without
 * already knowing an internal DB id: fresh session -> property.list -> pick
 * `id` -> property.snapshot. Never workspace-scoped, matching the cross-
 * workspace founder read authority already established by property.snapshot
 * and getFounderPropertySnapshot. Returns only founder-safe selection fields —
 * no metadata, no specifications, no internal-only status detail.
 */
export const propertyListCapability: RegisteredCapability<Record<string, never>, PropertyListItem[]> = {
  manifest: {
    name: 'property.list',
    version: 1,
    namespace: 'property',
    description: 'List founder-visible properties (label, safe location, stable selector) for discovery before calling property.snapshot.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'property.list.input.v1',
    outputSchemaId: 'property.list.output.v1',
  },

  async execute() {
    try {
      const properties = await listFounderProperties()
      const data: PropertyListItem[] = properties.map((row) => ({
        id: row.id,
        name: row.name,
        locationLabel: row.location_label,
      }))
      return {
        status: 'observed',
        data,
        evidence: data.map((item) => ({ kind: 'record' as const, id: item.id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return unavailable()
    }
  },
}
