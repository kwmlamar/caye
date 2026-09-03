import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createBedrockAdapter } from '@/lib/domain-adapters/bedrock/runtime'
import { BedrockNotFoundError } from '@/lib/domain-adapters/bedrock/types'
import { detectFreightRequest } from '@/lib/freight/detection'
import { purchaseEvidenceFromObservation } from '@/lib/freight/evidence'
import type { PurchaseEvidence } from '@/lib/freight/types'
import type { InvoiceProposalSource } from './compose'

const EVIDENCE_WINDOW_DAYS = 90
const PURCHASE_KEYS = ['vendor', 'seller', 'merchant', 'total', 'order_number', 'receipt_number', 'invoice_number', 'line_items']

/**
 * Production reads for the invoice-proposal path.
 *
 * Deliberately mirrors the queries the founder freight route already runs
 * (`app/api/founder/freight-workflow/route.ts`) so the proposal is built from
 * exactly the evidence a human reviewer would see. Read-only: the service
 * client is used for `select` only, and this module exposes no writer.
 */
export function createSupabaseInvoiceProposalSource(): InvoiceProposalSource {
  const db = createServiceClient()

  return {
    async loadFreightRequest({ workspaceId, conversationId }) {
      const { data: conversation } = await db
        .from('unified_conversations')
        .select('id,customer_id,metadata,connected_accounts!inner(user_id)')
        .eq('id', conversationId)
        .maybeSingle()
      if (!conversation) return null

      const account = Array.isArray(conversation.connected_accounts) ? conversation.connected_accounts[0] : conversation.connected_accounts
      if ((account as { user_id?: string } | null)?.user_id !== workspaceId) return null

      const { data: message } = await db
        .from('unified_messages')
        .select('id,content,sent_at,metadata')
        .eq('conversation_id', conversation.id)
        .eq('sender_type', 'customer')
        .eq('is_internal', false)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!message) return null

      const conversationMetadata = (conversation.metadata ?? {}) as Record<string, unknown>
      const messageMetadata = (message.metadata ?? {}) as Record<string, unknown>
      const request = detectFreightRequest({
        subject: String(messageMetadata.subject ?? conversationMetadata.subject ?? ''),
        body: message.content,
        from: String(messageMetadata.from ?? conversationMetadata.from ?? conversation.customer_id),
        receivedAt: message.sent_at,
      })
      return { request, requestMessageId: message.id }
    },

    async loadPurchaseEvidence({ workspaceId }) {
      const since = new Date(Date.now() - EVIDENCE_WINDOW_DAYS * 86_400_000).toISOString()
      const { data } = await db
        .from('business_artifact_observations')
        .select('artifact_id,content,business_artifacts!inner(filename,source_channel,received_at)')
        .eq('workspace_id', workspaceId)
        .in('observation_type', ['document_extraction', 'entity_observation'])
        .is('superseded_at', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100)

      return (data ?? []).flatMap((row): PurchaseEvidence[] => {
        const content = row.content && typeof row.content === 'object' ? row.content as Record<string, unknown> : {}
        if (!PURCHASE_KEYS.some((key) => key in content)) return []
        const artifact = Array.isArray(row.business_artifacts) ? row.business_artifacts[0] : row.business_artifacts
        const sourceChannel = String((artifact as { source_channel?: string } | null)?.source_channel ?? '')
        return [purchaseEvidenceFromObservation({
          workspaceId,
          artifactId: String(row.artifact_id),
          source: sourceChannel.startsWith('email_') ? 'email' : 'artifact',
          filename: (artifact as { filename?: string | null } | null)?.filename ?? null,
          content,
        })]
      })
    },

    async loadBusinessName({ workspaceId }) {
      const { data } = await db.from('customers').select('business_name').eq('id', workspaceId).maybeSingle()
      return data?.business_name ?? 'Business'
    },

    async loadEstimate({ workspaceId, estimateId }) {
      try {
        return await createBedrockAdapter().getEstimate(workspaceId, estimateId)
      } catch (error) {
        if (error instanceof BedrockNotFoundError) return null
        throw error
      }
    },
  }
}
