import 'server-only'
import { recordWorkOpportunity, resolveCayeRelationship } from '@/lib/caye-relationships'
import { deriveSalesWorkOpportunity } from './opportunity-fit'

/** Sales consumes generic relationships/opportunities; it does not own them. */
export async function bridgeSalesInboundToWork(input: {
  workspaceId: string
  contactId: string
  leadId: string
  conversationId?: string | null
  providerMessageId?: string | null
  body?: string | null
  observedAt?: string
}): Promise<{ relationshipId: string; opportunityId: string | null }> {
  const observedAt = input.observedAt ?? new Date().toISOString()
  const relationshipId = await resolveCayeRelationship({
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    originatingCapability: 'sales',
    interactionAt: observedAt,
    markEngaged: true,
  })
  const candidate = deriveSalesWorkOpportunity(input.body)
  if (!candidate) return { relationshipId, opportunityId: null }
  const sourceId = input.providerMessageId ?? `conversation:${input.conversationId ?? 'unknown'}:human_reply`
  const opportunityId = await recordWorkOpportunity({
    workspaceId: input.workspaceId,
    relationshipId,
    originatingCapability: 'sales',
    ...candidate,
    sourceType: 'sales_inbound_message',
    sourceId,
    observedAt,
    provenanceMetadata: {
      lead_id: input.leadId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    },
  })
  return { relationshipId, opportunityId }
}
