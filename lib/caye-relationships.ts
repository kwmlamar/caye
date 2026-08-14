import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type OpportunityConfidence = 'medium' | 'high'

export interface ResolveRelationshipInput {
  workspaceId: string
  contactId: string
  originatingCapability: string
  interactionAt: string
  markEngaged?: boolean
}

/** Generic Caye relationship seam. Counterparty identity remains in contacts. */
export async function resolveCayeRelationship(input: ResolveRelationshipInput): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_resolve_relationship', {
    p_workspace_id: input.workspaceId,
    p_contact_id: input.contactId,
    p_originating_capability: input.originatingCapability,
    p_interaction_at: input.interactionAt,
    p_mark_engaged: input.markEngaged ?? false,
  })
  if (error || !data) throw new Error(`relationship was not resolved: ${error?.message ?? 'no id returned'}`)
  return data as string
}

export interface RecordWorkOpportunityInput {
  workspaceId: string
  relationshipId: string
  originatingCapability: string
  opportunityType: string
  capabilityKey: string
  subjectKey: string
  description: string
  inference: string
  confidence: OpportunityConfidence
  sourceType: string
  sourceId: string
  observedFact: string
  observedAt: string
  provenanceMetadata?: Record<string, unknown>
}

/** Writes one evidence-backed opportunity through the transactional DB seam. */
export async function recordWorkOpportunity(input: RecordWorkOpportunityInput): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_record_work_opportunity', {
    p_workspace_id: input.workspaceId,
    p_relationship_id: input.relationshipId,
    p_originating_capability: input.originatingCapability,
    p_opportunity_type: input.opportunityType,
    p_capability_key: input.capabilityKey,
    p_subject_key: input.subjectKey,
    p_description: input.description,
    p_inference: input.inference,
    p_confidence: input.confidence,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_observed_fact: input.observedFact,
    p_observed_at: input.observedAt,
    p_provenance_metadata: input.provenanceMetadata ?? {},
  })
  if (error || !data) throw new Error(`work opportunity was not recorded: ${error?.message ?? 'no id returned'}`)
  return data as string
}
