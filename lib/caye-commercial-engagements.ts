import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type CommercialEngagementType = 'one_time_paid' | 'subscription' | 'addon' | 'other_approved_paid'
export type CommercialEngagementStatus = 'paid' | 'active'

export async function recordCayeCommercialEngagement(input: {
  workspaceId: string; relationshipId: string; engagementType: CommercialEngagementType; status: CommercialEngagementStatus
  sourceSystem: 'stripe' | 'chargeanywhere' | 'approved_commercial_arrangement'; sourceId: string; idempotencyKey: string
  startedAt: string; termsReference?: string | null; amount?: number | null; currency?: string | null; provenanceMetadata?: Record<string, unknown>
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('caye_record_commercial_engagement', {
    p_workspace_id: input.workspaceId, p_relationship_id: input.relationshipId, p_engagement_type: input.engagementType,
    p_status: input.status, p_source_system: input.sourceSystem, p_source_id: input.sourceId,
    p_idempotency_key: input.idempotencyKey, p_started_at: input.startedAt, p_terms_reference: input.termsReference ?? null,
    p_amount: input.amount ?? null, p_currency: input.currency ?? null, p_provenance_metadata: input.provenanceMetadata ?? {},
  })
  if (error || !data) throw new Error(`commercial engagement was not recorded: ${error?.message ?? 'no id returned'}`)
  return data as string
}
