import 'server-only'

import { listEngineeringProjects } from '@/lib/engineering-projects/store'
import { getPropertySnapshot, resolveFounderPropertyWorkspaceId } from '@/lib/property/store'
import type { CapabilityEvidenceRef, CapabilityResult, RegisteredCapability } from './types'

export type PropertySnapshotStructure = {
  name: string
  structureType: string
}

export type PropertySnapshotSystem = {
  name: string
  systemType: string
  status: string
  /** Human label of the structure this system belongs to, if any. Not a DB id. */
  structureName: string | null
}

export type PropertySnapshotAsset = {
  name: string
  assetType: string
  manufacturer: string | null
  model: string | null
  status: string
  structureName: string | null
  systemName: string | null
}

export type PropertySnapshotObservation = {
  key: string
  numericValue: number | null
  textValue: string | null
  unit: string | null
  provenanceStatus: string
  confidence: number | null
  observedAt: string
  notes: string | null
  /** Human label of what this observation is about (an asset/system/structure name, or "property"). Not a DB id. */
  subjectLabel: string
}

export type PropertySnapshotProject = {
  name: string
  objective: string
  status: string
  priority: string
  updatedAt: string
}

export type PropertySnapshotOpenIssue = {
  kind: 'system' | 'asset'
  name: string
  status: string
}

export type PropertySnapshotResult = {
  property: {
    /** Deliberate public selector, the same value returned by property.list. */
    id: string
    name: string
    propertyType: string
    locationLabel: string | null
    status: string
  }
  structures: PropertySnapshotStructure[]
  systems: PropertySnapshotSystem[]
  assets: PropertySnapshotAsset[]
  currentObservations: PropertySnapshotObservation[]
  projects: PropertySnapshotProject[]
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
 *
 * Public output boundary: only explicitly allowlisted, human-meaningful fields
 * cross into `data`. Raw durable-storage blobs (structure/system `metadata`,
 * asset `specifications`) and internal record ids (structure/system/asset/
 * observation/project ids) never do — nested items are linked by resolved
 * human-readable name instead of id, and the property id is the one
 * deliberately public selector (the same value property.list returns).
 * Internal record ids remain available in `evidence`, per the existing
 * capability evidence contract.
 */
export const propertySnapshotCapability: RegisteredCapability<unknown, PropertySnapshotResult> = {
  manifest: {
    name: 'property.snapshot',
    version: 1,
    namespace: 'property',
    description: 'Read a founder-visible snapshot of one physical property (selected via property.list): identity, structures, systems, assets, current observations, linked engineering projects, and open issues.',
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

      const structureNameById = new Map(snapshot.structures.map((row) => [row.id, row.name]))
      const systemNameById = new Map(snapshot.systems.map((row) => [row.id, row.name]))
      const assetNameById = new Map(snapshot.assets.map((row) => [row.id, row.name]))

      const structures: PropertySnapshotStructure[] = snapshot.structures.map((row) => ({
        name: row.name,
        structureType: row.structure_type,
      }))
      const systems: PropertySnapshotSystem[] = snapshot.systems.map((row) => ({
        name: row.name,
        systemType: row.system_type,
        status: row.status,
        structureName: row.structure_id ? (structureNameById.get(row.structure_id) ?? null) : null,
      }))
      const assets: PropertySnapshotAsset[] = snapshot.assets.map((row) => ({
        name: row.name,
        assetType: row.asset_type,
        manufacturer: row.manufacturer,
        model: row.model,
        status: row.status,
        structureName: row.structure_id ? (structureNameById.get(row.structure_id) ?? null) : null,
        systemName: row.system_id ? (systemNameById.get(row.system_id) ?? null) : null,
      }))
      const currentObservations: PropertySnapshotObservation[] = snapshot.current_observations.map((row) => {
        const subjectLabel =
          (row.asset_id !== null ? assetNameById.get(row.asset_id) : undefined) ??
          (row.system_id !== null ? systemNameById.get(row.system_id) : undefined) ??
          (row.structure_id !== null ? structureNameById.get(row.structure_id) : undefined) ??
          'property'
        return {
          key: row.observation_key,
          numericValue: row.numeric_value,
          textValue: row.text_value,
          unit: row.unit,
          provenanceStatus: row.provenance_status,
          confidence: row.confidence,
          observedAt: row.observed_at,
          notes: row.notes,
          subjectLabel,
        }
      })
      const projectItems: PropertySnapshotProject[] = projects.map((row) => ({
        name: row.name,
        objective: row.objective,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updated_at,
      }))
      const openIssues: PropertySnapshotOpenIssue[] = [
        ...snapshot.systems
          .filter((system) => NEEDS_ATTENTION_STATUSES.has(system.status))
          .map((system) => ({ kind: 'system' as const, name: system.name, status: system.status })),
        ...snapshot.assets
          .filter((asset) => NEEDS_ATTENTION_STATUSES.has(asset.status))
          .map((asset) => ({ kind: 'asset' as const, name: asset.name, status: asset.status })),
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
        ...snapshot.structures.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...snapshot.systems.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...snapshot.assets.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...snapshot.current_observations.map((row) => ({ kind: 'record' as const, id: row.id })),
        ...projects.map((row) => ({ kind: 'record' as const, id: row.id })),
      ]

      return { status: 'observed', data, evidence, executionRef: null, auditRef: null, failure: null }
    } catch {
      return unavailable()
    }
  },
}
