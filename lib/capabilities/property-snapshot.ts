import 'server-only'

import { listEngineeringProjects } from '@/lib/engineering-projects/store'
import { getPropertySnapshot, resolveFounderPropertyWorkspaceId } from '@/lib/property/store'
import type { CapabilityEvidenceRef, CapabilityResult, RegisteredCapability } from './types'

export type PropertySnapshotObservation = {
  id: string
  structureId: string | null
  systemId: string | null
  assetId: string | null
  key: string
  numericValue: number | null
  textValue: string | null
  unit: string | null
  provenanceStatus: string
  confidence: number | null
  observedAt: string
  notes: string | null
}

export type PropertySnapshotOpenIssue = {
  kind: 'system' | 'asset'
  id: string
  name: string
  status: string
}

export type PropertySnapshotResult = {
  property: {
    id: string
    name: string
    propertyType: string
    locationLabel: string | null
    status: string
  }
  structures: Array<{ id: string; name: string; structureType: string; metadata: unknown }>
  systems: Array<{ id: string; structureId: string | null; name: string; systemType: string; status: string; metadata: unknown }>
  assets: Array<{
    id: string
    structureId: string | null
    systemId: string | null
    name: string
    assetType: string
    manufacturer: string | null
    model: string | null
    status: string
    specifications: unknown
  }>
  currentObservations: PropertySnapshotObservation[]
  projects: Array<{ id: string; name: string; objective: string; status: string; priority: string; updatedAt: string }>
  openIssues: PropertySnapshotOpenIssue[]
}

function invalidArgs(message: string): CapabilityResult<PropertySnapshotResult> {
  return {
    status: 'failed',
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'invalid_args', message, retryable: false },
  }
}

function notFound(): CapabilityResult<PropertySnapshotResult> {
  return {
    status: 'failed',
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'not_found', message: 'Property not found.', retryable: false },
  }
}

function unavailable(): CapabilityResult<PropertySnapshotResult> {
  return {
    status: 'failed',
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'unavailable', message: 'Property snapshot could not be read.', retryable: true },
  }
}

function readPropertyId(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const value = (args as Record<string, unknown>).propertyId
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const NEEDS_ATTENTION_STATUSES = new Set(['needs_attention', 'unknown'])

/**
 * Founder-only physical property snapshot (CAY-28). Resolves the owning workspace
 * canonically from the property id itself, rather than trusting a caller-supplied
 * workspace scope, so a caller cannot smuggle a different workspace's authority
 * through context.scope.workspaceId. Reuses the same domain reads that back the
 * existing founder property-snapshot REST route and Caye Direct tool.
 */
export const propertySnapshotCapability: RegisteredCapability<unknown, PropertySnapshotResult> = {
  manifest: {
    name: 'property.snapshot',
    version: 1,
    namespace: 'property',
    description: 'Read a founder-visible snapshot of one physical property: identity, structures, systems, assets, current observations, linked engineering projects, and open issues.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'property.snapshot.input.v1',
    outputSchemaId: 'property.snapshot.output.v1',
  },

  async execute(args) {
    const propertyId = readPropertyId(args)
    if (!propertyId) return invalidArgs('propertyId is required.')

    try {
      const workspaceId = await resolveFounderPropertyWorkspaceId(propertyId)
      if (!workspaceId) return notFound()

      const [snapshot, projects] = await Promise.all([
        getPropertySnapshot(workspaceId, propertyId),
        listEngineeringProjects(workspaceId, propertyId),
      ])
      if (!snapshot) return notFound()

      const structures = snapshot.structures.map((row) => ({
        id: row.id,
        name: row.name,
        structureType: row.structure_type,
        metadata: row.metadata,
      }))
      const systems = snapshot.systems.map((row) => ({
        id: row.id,
        structureId: row.structure_id,
        name: row.name,
        systemType: row.system_type,
        status: row.status,
        metadata: row.metadata,
      }))
      const assets = snapshot.assets.map((row) => ({
        id: row.id,
        structureId: row.structure_id,
        systemId: row.system_id,
        name: row.name,
        assetType: row.asset_type,
        manufacturer: row.manufacturer,
        model: row.model,
        status: row.status,
        specifications: row.specifications,
      }))
      const currentObservations = snapshot.current_observations.map((row) => ({
        id: row.id,
        structureId: row.structure_id,
        systemId: row.system_id,
        assetId: row.asset_id,
        key: row.observation_key,
        numericValue: row.numeric_value,
        textValue: row.text_value,
        unit: row.unit,
        provenanceStatus: row.provenance_status,
        confidence: row.confidence,
        observedAt: row.observed_at,
        notes: row.notes,
      }))
      const projectItems = projects.map((row) => ({
        id: row.id,
        name: row.name,
        objective: row.objective,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updated_at,
      }))
      const openIssues: PropertySnapshotOpenIssue[] = [
        ...systems
          .filter((system) => NEEDS_ATTENTION_STATUSES.has(system.status))
          .map((system) => ({ kind: 'system' as const, id: system.id, name: system.name, status: system.status })),
        ...assets
          .filter((asset) => NEEDS_ATTENTION_STATUSES.has(asset.status))
          .map((asset) => ({ kind: 'asset' as const, id: asset.id, name: asset.name, status: asset.status })),
      ]

      const data: PropertySnapshotResult = {
        property: {
          id: snapshot.property.id,
          name: snapshot.property.name,
          propertyType: snapshot.property.property_type,
          locationLabel: snapshot.property.location_label,
          status: snapshot.property.status,
        },
        structures,
        systems,
        assets,
        currentObservations,
        projects: projectItems,
        openIssues,
      }

      const evidence: CapabilityEvidenceRef[] = [
        { kind: 'record', id: data.property.id },
        ...structures.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...systems.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...assets.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...currentObservations.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...projectItems.map((row) => ({ kind: 'record' as const, id: row.id })),
      ]

      return { status: 'observed', data, evidence, executionRef: null, auditRef: null, failure: null }
    } catch {
      return unavailable()
    }
  },
}
