import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type AuthorizationType = 'one_time' | 'standing' | 'mandate'
export type JobWorkType = 'bounded' | 'recurring' | 'continuous'
export type AuthorizationAuthorizer =
  | { kind: 'workspace_operator'; operatorId: number }
  | { kind: 'external_representative'; contactId: string }

export async function createCayeAuthorization(input: {
  workspaceId: string; relationshipId: string; opportunityId: string
  authorizer: AuthorizationAuthorizer; sourceChannel: string; sourceType: string; sourceId: string
  authorityType: AuthorizationType; capabilityKey: string; scopeSubjectKey: string
  scopeDescription: string; scopeMetadata?: Record<string, unknown>; authorizedAt: string; expiresAt?: string | null
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_create_authorization', {
    p_workspace_id: input.workspaceId, p_relationship_id: input.relationshipId, p_opportunity_id: input.opportunityId,
    p_authorizer_kind: input.authorizer.kind,
    p_authorized_by_operator_id: input.authorizer.kind === 'workspace_operator' ? input.authorizer.operatorId : null,
    p_authorized_by_contact_id: input.authorizer.kind === 'external_representative' ? input.authorizer.contactId : null,
    p_source_channel: input.sourceChannel,
    p_source_type: input.sourceType, p_source_id: input.sourceId, p_authority_type: input.authorityType,
    p_capability_key: input.capabilityKey, p_scope_subject_key: input.scopeSubjectKey,
    p_scope_description: input.scopeDescription, p_scope_metadata: input.scopeMetadata ?? {},
    p_authorized_at: input.authorizedAt, p_expires_at: input.expiresAt ?? null,
  })
  if (error || !data) throw new Error(`authorization was not created: ${error?.message ?? 'no id returned'}`)
  return data as string
}

export async function revokeCayeAuthorization(input: {
  workspaceId: string; authorizationId: string; revokedByOperatorId: number; revokedAt: string; reason?: string | null
}): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('caye_revoke_authorization', {
    p_workspace_id: input.workspaceId, p_authorization_id: input.authorizationId,
    p_revoked_by_operator_id: input.revokedByOperatorId, p_revoked_at: input.revokedAt, p_reason: input.reason ?? null,
  })
  if (error) throw new Error(`authorization was not revoked: ${error.message}`)
  return data === true
}

export async function createCayeJob(input: {
  workspaceId: string; relationshipId: string; opportunityId: string; authorizationId: string
  owningCapability: string; jobKey: string; workType: JobWorkType; objective: string; primarySubjectRef?: string | null; at: string
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_create_authorized_job', {
    p_workspace_id: input.workspaceId, p_relationship_id: input.relationshipId, p_opportunity_id: input.opportunityId,
    p_authorization_id: input.authorizationId, p_owning_capability: input.owningCapability,
    p_job_key: input.jobKey, p_work_type: input.workType, p_objective: input.objective,
    p_primary_subject_ref: input.primarySubjectRef ?? null, p_at: input.at,
  })
  if (error || !data) throw new Error(`job was not created: ${error?.message ?? 'no id returned'}`)
  return data as string
}

/** Re-checks Phase 3 prerequisites only; it never starts or executes a job. */
export async function reevaluateCayeJob(input: { workspaceId: string; jobId: string; at: string }): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('caye_reevaluate_job', {
    p_workspace_id: input.workspaceId, p_job_id: input.jobId, p_at: input.at,
  })
  if (error) throw new Error(`job was not reevaluated: ${error.message}`)
  return data === true
}
