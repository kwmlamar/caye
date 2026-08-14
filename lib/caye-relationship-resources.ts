import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export async function linkCayeRelationshipOperatingWorkspace(input: {
  workspaceId: string; relationshipId: string; operatingWorkspaceId: string; verifiedByOperatorId: number
  sourceSystem: string; sourceId: string; verifiedAt: string; provenanceMetadata?: Record<string, unknown>
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_link_relationship_operating_workspace', {
    p_workspace_id: input.workspaceId, p_relationship_id: input.relationshipId, p_operating_workspace_id: input.operatingWorkspaceId,
    p_verified_by_operator_id: input.verifiedByOperatorId, p_source_system: input.sourceSystem, p_source_id: input.sourceId,
    p_verified_at: input.verifiedAt, p_provenance_metadata: input.provenanceMetadata ?? {},
  })
  if (error || !data) throw new Error(`relationship operating workspace was not linked: ${error?.message ?? 'no id returned'}`)
  return data as string
}

export async function verifyCayeRelationshipResource(input: {
  workspaceId: string; relationshipId: string; operatingWorkspaceId: string; operatingWorkspaceLinkId: string
  nativeResourceId: string; verifiedByOperatorId: number; sourceSystem: string; sourceId: string; verifiedAt: string
  provenanceMetadata?: Record<string, unknown>
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_verify_relationship_resource', {
    p_workspace_id: input.workspaceId, p_relationship_id: input.relationshipId, p_operating_workspace_id: input.operatingWorkspaceId,
    p_operating_workspace_link_id: input.operatingWorkspaceLinkId, p_native_resource_id: input.nativeResourceId,
    p_verified_by_operator_id: input.verifiedByOperatorId, p_source_system: input.sourceSystem, p_source_id: input.sourceId,
    p_verified_at: input.verifiedAt, p_provenance_metadata: input.provenanceMetadata ?? {},
  })
  if (error || !data) throw new Error(`relationship resource was not verified: ${error?.message ?? 'no id returned'}`)
  return data as string
}

export async function revokeCayeRelationshipResource(input: { workspaceId: string; resourceId: string; revokedAt: string; reason?: string | null }): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('caye_revoke_relationship_resource', {
    p_workspace_id: input.workspaceId, p_resource_id: input.resourceId, p_revoked_at: input.revokedAt, p_reason: input.reason ?? null,
  })
  if (error) throw new Error(`relationship resource was not revoked: ${error.message}`)
  return data === true
}
