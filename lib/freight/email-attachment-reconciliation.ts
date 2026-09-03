import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { detectFreightRequest } from './detection'
import { purchaseEvidenceFromObservation } from './evidence'
import { rankPurchaseEvidence } from './matching'
import { isTrustedPurchaseEvidenceType, type EmailDocumentType } from '@/lib/artifacts/email-evidence-semantics'
import { relateEmailArtifactToFreightRequest } from '@/lib/artifacts/email-attachments'

export interface FreightEmailMessageContext {
  workspaceId: string
  unifiedMessageId: string
  providerMessageId: string
  subject: string
  from: string
  body: string
  receivedAt: string
}

/**
 * Relates already-ingested email artifacts to one deterministic #434 freight
 * request. This is reconciliation only: it writes Caye artifact relations and
 * never calls Bedrock or an email send path.
 */
export async function reconcileFreightEmailAttachmentEvidence(message: FreightEmailMessageContext): Promise<{ freightRequestId: string | null; purchaseCandidates: number; shipmentEvidence: number }> {
  const request = detectFreightRequest({
    subject: message.subject,
    body: message.body,
    from: message.from,
    receivedAt: message.receivedAt,
  })
  if (!request.isFreightDocumentRequest) return { freightRequestId: null, purchaseCandidates: 0, shipmentEvidence: 0 }

  const db = createServiceClient()
  const freightRequestId = `freight:${message.unifiedMessageId}`
  const since = new Date(new Date(message.receivedAt).getTime() - 90 * 86_400_000).toISOString()
  const { data: observations, error } = await db
    .from('business_artifact_observations')
    .select('id,artifact_id,content,business_artifacts!inner(filename,source_channel,received_at)')
    .eq('workspace_id', message.workspaceId)
    .eq('observation_type', 'entity_observation')
    .eq('model_version', 'email-evidence-v1')
    .is('superseded_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`freight email evidence query failed: ${error.message}`)

  let shipmentEvidence = 0
  const purchaseRows: Array<{ observationId: string; artifactId: string; documentType: EmailDocumentType; evidence: ReturnType<typeof purchaseEvidenceFromObservation> }> = []

  for (const row of observations ?? []) {
    const content = row.content && typeof row.content === 'object' ? row.content as Record<string, unknown> : {}
    const documentType = String(content.document_type ?? 'unknown') as EmailDocumentType
    const sourceMessageId = String(content.source_message_id ?? '')
    if (sourceMessageId === message.providerMessageId && (documentType === 'dock_receipt' || documentType === 'freight_document' || documentType === 'freight_invoice')) {
      await relateEmailArtifactToFreightRequest({
        workspaceId: message.workspaceId,
        artifactId: String(row.artifact_id),
        freightRequestId,
        documentType,
        sourceObservationId: String(row.id),
      })
      shipmentEvidence++
    }
    if (!isTrustedPurchaseEvidenceType(documentType)) continue
    const artifact = Array.isArray((row as any).business_artifacts) ? (row as any).business_artifacts[0] : (row as any).business_artifacts
    purchaseRows.push({
      observationId: String(row.id),
      artifactId: String(row.artifact_id),
      documentType,
      evidence: purchaseEvidenceFromObservation({
        workspaceId: message.workspaceId,
        artifactId: String(row.artifact_id),
        source: String(artifact?.source_channel ?? '').startsWith('email_') ? 'email' : 'artifact',
        filename: artifact?.filename ?? null,
        content,
      }),
    })
  }

  const ranked = rankPurchaseEvidence(request, purchaseRows.map(row => row.evidence))
  let purchaseCandidates = 0
  for (const candidate of ranked.candidates) {
    // A zero-score document is merely in the same workspace/time window, not
    // evidence for this shipment. Keep the relation graph useful rather than
    // turning every receipt into a candidate for every freight request.
    if (candidate.score <= 0) continue
    const source = purchaseRows.find(row => row.artifactId === candidate.evidence.id)
    if (!source) continue
    await relateEmailArtifactToFreightRequest({
      workspaceId: message.workspaceId,
      artifactId: source.artifactId,
      freightRequestId,
      documentType: source.documentType,
      sourceObservationId: source.observationId,
    })
    purchaseCandidates++
  }

  return { freightRequestId, purchaseCandidates, shipmentEvidence }
}
