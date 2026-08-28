import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type PropertyObservationProvenance = 'measured' | 'observed' | 'operator_confirmed' | 'inferred' | 'estimated'

export async function createProperty(input: { workspaceId: string; name: string; propertyType?: string; locationLabel?: string | null; metadata?: Record<string, unknown> }) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('physical_properties').insert({ workspace_id: input.workspaceId, name: input.name.trim(), property_type: input.propertyType ?? 'residential', location_label: input.locationLabel ?? null, metadata: input.metadata ?? {} }).select('id,name,property_type,location_label,status').single()
  if (error || !data) throw new Error('Could not create property')
  return data
}

async function requireProperty(workspaceId: string, propertyId: string) {
  const supabase = createServiceClient()
  const { data } = await supabase.from('physical_properties').select('id').eq('workspace_id', workspaceId).eq('id', propertyId).maybeSingle()
  if (!data) throw new Error('Property not found in this workspace')
}

async function requireScopedEntity(table: 'property_structures' | 'property_systems' | 'property_assets', workspaceId: string, propertyId: string, id: string, label: string) {
  const supabase = createServiceClient()
  const { data } = await supabase.from(table).select('id').eq('workspace_id', workspaceId).eq('property_id', propertyId).eq('id', id).maybeSingle()
  if (!data) throw new Error(`${label} is not part of this property`)
}

export async function addPropertyStructure(input: { workspaceId: string; propertyId: string; name: string; structureType?: string; metadata?: Record<string, unknown> }) {
  await requireProperty(input.workspaceId, input.propertyId)
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('property_structures').insert({ workspace_id: input.workspaceId, property_id: input.propertyId, name: input.name.trim(), structure_type: input.structureType ?? 'building', metadata: input.metadata ?? {} }).select('id,name,structure_type,metadata').single()
  if (error || !data) throw new Error('Could not create property structure')
  return data
}

export async function addPropertySystem(input: { workspaceId: string; propertyId: string; structureId?: string | null; name: string; systemType: string; status?: string; metadata?: Record<string, unknown> }) {
  await requireProperty(input.workspaceId, input.propertyId)
  if (input.structureId) await requireScopedEntity('property_structures', input.workspaceId, input.propertyId, input.structureId, 'Structure')
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('property_systems').insert({ workspace_id: input.workspaceId, property_id: input.propertyId, structure_id: input.structureId ?? null, name: input.name.trim(), system_type: input.systemType, status: input.status ?? 'active', metadata: input.metadata ?? {} }).select('id,name,system_type,status').single()
  if (error || !data) throw new Error('Could not create property system')
  return data
}

export async function addPropertyAsset(input: { workspaceId: string; propertyId: string; systemId?: string | null; structureId?: string | null; name: string; assetType: string; manufacturer?: string | null; model?: string | null; status?: string; specifications?: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  await requireProperty(input.workspaceId, input.propertyId)
  if (input.structureId) await requireScopedEntity('property_structures', input.workspaceId, input.propertyId, input.structureId, 'Structure')
  if (input.systemId) await requireScopedEntity('property_systems', input.workspaceId, input.propertyId, input.systemId, 'System')
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('property_assets').insert({ workspace_id: input.workspaceId, property_id: input.propertyId, system_id: input.systemId ?? null, structure_id: input.structureId ?? null, name: input.name.trim(), asset_type: input.assetType.trim(), manufacturer: input.manufacturer ?? null, model: input.model ?? null, status: input.status ?? 'unknown', specifications: input.specifications ?? {}, metadata: input.metadata ?? {} }).select('id,name,asset_type,manufacturer,model,status,specifications').single()
  if (error || !data) throw new Error('Could not create property asset')
  return data
}

export async function recordPropertyObservation(input: { workspaceId: string; propertyId: string; structureId?: string | null; systemId?: string | null; assetId?: string | null; key: string; numericValue?: number; textValue?: string; unit?: string; provenanceStatus: PropertyObservationProvenance; confidence?: number | null; sourceArtifactId?: string | null; sourceMessageId?: string | null; notes?: string | null; observedAt?: string }) {
  await requireProperty(input.workspaceId, input.propertyId)
  if (input.structureId) await requireScopedEntity('property_structures', input.workspaceId, input.propertyId, input.structureId, 'Structure')
  if (input.systemId) await requireScopedEntity('property_systems', input.workspaceId, input.propertyId, input.systemId, 'System')
  if (input.assetId) await requireScopedEntity('property_assets', input.workspaceId, input.propertyId, input.assetId, 'Asset')
  const numeric = typeof input.numericValue === 'number'
  const textual = typeof input.textValue === 'string' && input.textValue.trim().length > 0
  if (numeric === textual) throw new Error('Observation must contain exactly one numeric or text value')
  if (numeric && !input.unit) throw new Error('Numeric observations require an explicit unit')
  const supabase = createServiceClient()
  if (input.sourceArtifactId) {
    const { data: artifact } = await supabase.from('business_artifacts').select('id').eq('workspace_id', input.workspaceId).eq('id', input.sourceArtifactId).maybeSingle()
    if (!artifact) throw new Error('Source artifact is not in this workspace')
  }
  if (input.sourceMessageId) {
    const { data: message } = await supabase.from('caye_operator_messages').select('id').eq('workspace_id', input.workspaceId).eq('id', input.sourceMessageId).maybeSingle()
    if (!message) throw new Error('Source message is not in this workspace')
  }
  const { data, error } = await supabase.from('property_observations').insert({ workspace_id: input.workspaceId, property_id: input.propertyId, structure_id: input.structureId ?? null, system_id: input.systemId ?? null, asset_id: input.assetId ?? null, observation_key: input.key.trim(), numeric_value: numeric ? input.numericValue : null, text_value: textual ? input.textValue!.trim() : null, unit: numeric ? input.unit : null, provenance_status: input.provenanceStatus, confidence: input.confidence ?? null, source_artifact_id: input.sourceArtifactId ?? null, source_message_id: input.sourceMessageId ?? null, notes: input.notes ?? null, observed_at: input.observedAt ?? new Date().toISOString() }).select('id,observation_key,numeric_value,text_value,unit,provenance_status,confidence,observed_at').single()
  if (error || !data) throw new Error('Could not record property observation')
  return data
}

export async function getPropertySnapshot(workspaceId: string, propertyId: string) {
  const supabase = createServiceClient()
  const { data: property } = await supabase.from('physical_properties').select('id,name,property_type,location_label,status,metadata,created_at,updated_at').eq('workspace_id', workspaceId).eq('id', propertyId).maybeSingle()
  if (!property) return null
  const [{ data: structures }, { data: systems }, { data: assets }, { data: observations }] = await Promise.all([
    supabase.from('property_structures').select('id,name,structure_type,metadata').eq('workspace_id', workspaceId).eq('property_id', propertyId).order('created_at'),
    supabase.from('property_systems').select('id,structure_id,name,system_type,status,metadata').eq('workspace_id', workspaceId).eq('property_id', propertyId).order('created_at'),
    supabase.from('property_assets').select('id,structure_id,system_id,name,asset_type,manufacturer,model,status,specifications,metadata').eq('workspace_id', workspaceId).eq('property_id', propertyId).order('created_at'),
    supabase.from('property_observations').select('id,structure_id,system_id,asset_id,observation_key,numeric_value,text_value,unit,provenance_status,confidence,observed_at,notes').eq('workspace_id', workspaceId).eq('property_id', propertyId).order('observed_at', { ascending: false }).limit(100),
  ])
  return { property, structures: structures ?? [], systems: systems ?? [], assets: assets ?? [], observations: observations ?? [] }
}

export async function listProperties(workspaceId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('physical_properties').select('id,name,property_type,location_label,status,updated_at').eq('workspace_id', workspaceId).neq('status','archived').order('updated_at', { ascending: false })
  if (error) throw new Error('Could not list properties')
  return data ?? []
}
