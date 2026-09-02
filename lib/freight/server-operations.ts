import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { detectFreightRequest } from '@/lib/freight/detection'
import { purchaseEvidenceFromObservation } from '@/lib/freight/evidence'
import { rankPurchaseEvidence } from '@/lib/freight/matching'
import { buildFreightDocumentData, prepareFreightReply, renderFreightDocumentPdf } from '@/lib/freight/document'
import { ingestArtifact } from '@/lib/artifacts/ingest'
import { downloadArtifactBytes, signArtifactUrl } from '@/lib/artifacts/storage'
import { sendGmailReplyWithAttachments } from '@/lib/gmail-send'
import {
  claimConversationExecution,
  completeConversationExecution,
  releaseConversationExecution,
  resolveConversationExecutionAfterFailure,
  validateConversationExecution,
} from '@/lib/conversation-execution'
import { classifyFreightSendFailure } from '@/lib/freight/send-safety'
import { DispatchAmbiguousError } from '@/lib/whatsapp/channel-dispatch'
import { artifactVersion, bindFreightApproval, validateFreightApproval, type FreightApprovalBinding } from '@/lib/freight/whatsapp-orchestration'
import type { FreightWorkflowRecord } from '@/lib/freight/workflow'
import type { PurchaseEvidence } from '@/lib/freight/types'

export type FreightConversation = {
  id: string
  channel_type: string
  channel_conversation_id: string
  customer_id: string
  customer_name: string | null
  metadata: Record<string, unknown>
  connected_accounts: { user_id: string } | Array<{ user_id: string }>
}

export type FreightActor = {
  userId: string
  actorKind: 'founder' | 'owner' | 'staff'
  operatorId?: number | null
}

export class FreightOperationError extends Error {
  constructor(message: string, readonly status = 500, readonly code = 'FREIGHT_OPERATION_FAILED') {
    super(message)
    this.name = 'FreightOperationError'
  }
}

function accountWorkspaceId(conv: FreightConversation): string | null {
  const account = Array.isArray(conv.connected_accounts) ? conv.connected_accounts[0] : conv.connected_accounts
  return account?.user_id ?? null
}

export async function loadFreightConversation(workspaceId: string, conversationId: string): Promise<FreightConversation> {
  const db = createServiceClient()
  const { data } = await db
    .from('unified_conversations')
    .select('id,channel_type,channel_conversation_id,customer_id,customer_name,metadata,connected_accounts!inner(user_id)')
    .eq('id', conversationId)
    .single()
  const conv = data as unknown as FreightConversation | null
  if (!conv || accountWorkspaceId(conv) !== workspaceId) throw new FreightOperationError('Freight conversation not found in this workspace', 404, 'NOT_FOUND')
  return conv
}

export async function listFreightConversations(workspaceId: string) {
  const db = createServiceClient()
  const { data, error } = await db
    .from('unified_conversations')
    .select('id,customer_name,customer_id,metadata,last_message_at,channel_conversation_id,channel_type,connected_accounts!inner(user_id)')
    .eq('connected_accounts.user_id', workspaceId)
    .eq('channel_type', 'gmail')
    .order('last_message_at', { ascending: false })
    .limit(50)
  if (error) throw new FreightOperationError(error.message)
  return data ?? []
}

async function loadEvidence(workspaceId: string): Promise<PurchaseEvidence[]> {
  const db = createServiceClient()
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data, error } = await db
    .from('business_artifact_observations')
    .select('artifact_id,content,business_artifacts!inner(filename,source_channel,received_at)')
    .eq('workspace_id', workspaceId)
    .in('observation_type', ['document_extraction', 'entity_observation'])
    .is('superseded_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new FreightOperationError(error.message)
  return (data ?? []).flatMap((row: any) => {
    const content = row.content && typeof row.content === 'object' ? row.content as Record<string, unknown> : {}
    const looksPurchase = ['vendor', 'seller', 'merchant', 'total', 'order_number', 'receipt_number', 'invoice_number', 'line_items'].some(k => k in content)
    if (!looksPurchase) return []
    const artifact = Array.isArray(row.business_artifacts) ? row.business_artifacts[0] : row.business_artifacts
    return [purchaseEvidenceFromObservation({
      workspaceId,
      artifactId: String(row.artifact_id),
      source: String(artifact?.source_channel ?? '').startsWith('email_') ? 'email' : 'artifact',
      filename: artifact?.filename ?? null,
      content,
    })]
  })
}

export async function analyzeFreightWorkflow(workspaceId: string, conversationId: string): Promise<FreightWorkflowRecord | null> {
  const db = createServiceClient()
  const conv = await loadFreightConversation(workspaceId, conversationId)
  const existing = (conv.metadata?.freight_workflow ?? null) as FreightWorkflowRecord | null
  if (existing?.workspaceId === workspaceId && existing.conversationId === conversationId) return existing

  const { data: message, error } = await db
    .from('unified_messages')
    .select('id,content,sent_at,metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('is_internal', false)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new FreightOperationError(error.message)
  if (!message) return null

  const meta = (message.metadata ?? {}) as Record<string, unknown>
  const request = detectFreightRequest({
    subject: String(meta.subject ?? conv.metadata?.subject ?? ''),
    body: message.content,
    from: String(meta.from ?? conv.metadata?.from ?? conv.customer_id),
    receivedAt: message.sent_at,
  })
  if (!request.isFreightDocumentRequest) return null

  const match = rankPurchaseEvidence(request, await loadEvidence(workspaceId))
  const record: FreightWorkflowRecord = {
    id: `freight:${message.id}`,
    workspaceId,
    conversationId,
    requestMessageId: message.id,
    request,
    status: match.status,
    candidates: match.candidates,
    selectedEvidenceId: match.selection?.evidence.id ?? null,
    generatedArtifactId: null,
    reply: null,
    approvedAt: null,
    sentAt: null,
  }
  const { error: updateError } = await db
    .from('unified_conversations')
    .update({
      metadata: { ...conv.metadata, freight_workflow: record },
      human_agent_enabled: true,
      human_agent_reason: `Freight document requested for Dock Receipt ${request.dockReceiptNumber ?? 'UNKNOWN'} — review required`,
    })
    .eq('id', conversationId)
  if (updateError) throw new FreightOperationError(updateError.message)

  await db.from('workspace_events').insert({
    workspace_id: workspaceId,
    type: 'freight.request.detected',
    actor_kind: 'system',
    is_failure: false,
    subject_table: 'unified_conversations',
    subject_id: conversationId,
    payload: { workflow_id: record.id, request_message_id: message.id, dock_receipt_number: request.dockReceiptNumber, evidence: request.evidence },
    origin: 'app',
  })
  if (match.selection) {
    await db.from('workspace_events').insert({
      workspace_id: workspaceId,
      type: 'freight.purchase_evidence.matched',
      actor_kind: 'system',
      is_failure: false,
      subject_table: 'business_artifacts',
      subject_id: match.selection.evidence.id,
      payload: { workflow_id: record.id, confidence: match.selection.confidence, reasons: match.selection.reasons },
      origin: 'app',
    })
  }
  return record
}

export async function generateFreightDocument(input: {
  workspaceId: string
  conversationId: string
  evidenceId?: string | null
}): Promise<FreightWorkflowRecord> {
  const db = createServiceClient()
  const conv = await loadFreightConversation(input.workspaceId, input.conversationId)
  let record = await analyzeFreightWorkflow(input.workspaceId, input.conversationId)
  if (!record) throw new FreightOperationError('This is not a freight document request', 409, 'NOT_FREIGHT')
  if (record.generatedArtifactId) return record

  const evidenceId = input.evidenceId ?? record.selectedEvidenceId
  const ranked = evidenceId ? record.candidates.find(c => c.evidence.id === evidenceId) : undefined
  if (!ranked || ranked.evidence.workspaceId !== input.workspaceId) throw new FreightOperationError('Receipt candidate not found in this workspace', 404, 'EVIDENCE_NOT_FOUND')
  if (ranked.confidence !== 'HIGH') throw new FreightOperationError('I need you to choose the receipt before I make the freight document.', 409, 'EVIDENCE_AMBIGUOUS')

  const selected = ranked.evidence
  const { data: customer } = await db.from('customers').select('business_name').eq('id', input.workspaceId).maybeSingle()
  const document = buildFreightDocumentData(customer?.business_name ?? 'Business', record.request, selected)
  const bytes = renderFreightDocumentPdf(document)
  const ingested = await ingestArtifact({
    workspaceId: input.workspaceId,
    sourceChannel: 'dashboard',
    bytes,
    declaredMimeType: 'application/pdf',
    filename: `freight-${record.request.dockReceiptNumber}.pdf`,
    providerAttachmentId: `freight-document:${record.id}`,
    conversationId: input.conversationId,
    origin: 'caye_generated',
    senderLabel: 'Caye freight workflow',
  })
  if (!ingested.ok) throw new FreightOperationError(ingested.error)

  await db.from('business_artifact_observations').insert({
    artifact_id: ingested.artifact.id,
    workspace_id: input.workspaceId,
    observation_type: 'document_extraction',
    modality: 'document',
    content: { kind: 'freight_document', data: document, source_evidence_ids: document.sourceEvidence.map(e => e.id) },
    confidence: null,
    provenance_status: 'extracted',
    derived_by: 'system:freight-document-v1',
  })
  const confirmedAt = new Date().toISOString()
  await db.from('business_artifact_relations').insert([
    { workspace_id: input.workspaceId, artifact_id: ingested.artifact.id, relation_type: 'generated_from', target_entity_type: 'business_artifact', target_entity_id: selected.id, label: `Source purchase evidence for ${record.request.dockReceiptNumber}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: confirmedAt },
    { workspace_id: input.workspaceId, artifact_id: ingested.artifact.id, relation_type: 'answers_request', target_entity_type: 'unified_message', target_entity_id: record.requestMessageId, label: `Freight request ${record.request.dockReceiptNumber}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: confirmedAt },
    { workspace_id: input.workspaceId, artifact_id: ingested.artifact.id, relation_type: 'represents', target_entity_type: 'freight_request', target_entity_id: record.id, label: `Dock Receipt ${record.request.dockReceiptNumber}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: confirmedAt },
  ])

  record = {
    ...record,
    status: 'READY_FOR_APPROVAL',
    selectedEvidenceId: selected.id,
    generatedArtifactId: ingested.artifact.id,
    reply: prepareFreightReply(record.request),
    approvedAt: null,
  }
  const latestMetadata = { ...conv.metadata, freight_workflow: record }
  const { error: updateError } = await db.from('unified_conversations').update({ metadata: latestMetadata }).eq('id', input.conversationId)
  if (updateError) throw new FreightOperationError(updateError.message)

  await db.from('workspace_events').insert({
    workspace_id: input.workspaceId,
    type: 'freight.document.generated',
    actor_kind: 'caye',
    is_failure: false,
    subject_table: 'business_artifacts',
    subject_id: ingested.artifact.id,
    payload: { workflow_id: record.id, dock_receipt_number: record.request.dockReceiptNumber, source_artifact_id: selected.id, unresolved_fields: document.unresolvedFields },
    origin: 'app',
  })
  return record
}

export async function getGeneratedFreightArtifact(workspaceId: string, conversationId: string) {
  const db = createServiceClient()
  const record = await analyzeFreightWorkflow(workspaceId, conversationId)
  if (!record?.generatedArtifactId) throw new FreightOperationError('Freight document not found', 404, 'ARTIFACT_NOT_FOUND')
  const { data: artifact } = await db
    .from('business_artifacts')
    .select('id,workspace_id,storage_path,filename,detected_mime_type,content_sha256,updated_at')
    .eq('id', record.generatedArtifactId)
    .eq('workspace_id', workspaceId)
    .eq('storage_state', 'stored')
    .maybeSingle()
  if (!artifact) throw new FreightOperationError('Freight document not found', 404, 'ARTIFACT_NOT_FOUND')
  const url = await signArtifactUrl(artifact.storage_path)
  return {
    record,
    artifact,
    artifactVersion: artifactVersion({ artifactId: artifact.id, bytesHash: artifact.content_sha256, updatedAt: artifact.updated_at }),
    url,
  }
}

export type SendFreightResult =
  | { outcome: 'sent'; record: FreightWorkflowRecord; providerMessageId: string }
  | { outcome: 'already_sent'; record: FreightWorkflowRecord }
  | { outcome: 'ambiguous'; record: FreightWorkflowRecord; message: string }
  | { outcome: 'retryable_failure'; record: FreightWorkflowRecord; message: string }

export async function sendFreightDocument(input: {
  workspaceId: string
  conversationId: string
  actor: FreightActor
  approvalBinding?: FreightApprovalBinding | null
}): Promise<SendFreightResult> {
  const db = createServiceClient()
  const conv = await loadFreightConversation(input.workspaceId, input.conversationId)
  let record = await analyzeFreightWorkflow(input.workspaceId, input.conversationId)
  if (!record) throw new FreightOperationError('This is not a freight document request', 409, 'NOT_FREIGHT')
  if (record.status === 'SENT') return { outcome: 'already_sent', record }
  if (record.status !== 'READY_FOR_APPROVAL' || !record.generatedArtifactId || !record.reply) throw new FreightOperationError('Document is not ready for approval', 409, 'NOT_READY')
  if (conv.channel_type !== 'gmail') throw new FreightOperationError('Attachment sending is currently supported for connected Gmail threads only. No email was sent.', 422, 'UNSUPPORTED_PROVIDER')
  if (!input.actor.userId || (input.actor.actorKind !== 'owner' && input.actor.actorKind !== 'founder')) throw new FreightOperationError('Only an authorized owner can send this freight document.', 403, 'UNAUTHORIZED_ACTOR')
  if (input.actor.operatorId == null) throw new FreightOperationError('I could not verify who approved that send.', 403, 'UNKNOWN_OPERATOR')

  const { artifact, artifactVersion: version } = await getGeneratedFreightArtifact(input.workspaceId, input.conversationId)
  const recipient = record.request.senderEmail || conv.customer_id
  const emailThreadId = conv.channel_conversation_id
  const binding = input.approvalBinding ?? bindFreightApproval({
    workspaceId: input.workspaceId,
    workflowId: record.id,
    artifactId: artifact.id,
    artifactVersion: version,
    recipient,
    emailThreadId,
    actorOperatorId: input.actor.operatorId,
  })
  const validation = validateFreightApproval(binding, {
    workspaceId: input.workspaceId,
    workflowId: record.id,
    artifactId: artifact.id,
    artifactVersion: version,
    recipient,
    emailThreadId,
    actorOperatorId: input.actor.operatorId,
  })
  if (!validation.valid) throw new FreightOperationError(`Freight approval is no longer valid: ${validation.reason}`, 409, 'STALE_APPROVAL')

  const claim = await claimConversationExecution({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    holder: 'human_manual',
    idempotencyKey: `freight-send:${record.id}`,
    reason: 'owner approved freight document attachment',
    leaseSeconds: 120,
  })
  if (!claim.ok) throw new FreightOperationError(`Conversation is currently handled by ${claim.blockedBy}`, 409, 'EXECUTION_BLOCKED')

  let providerAccepted = false
  try {
    const valid = await validateConversationExecution({ claimId: claim.claim.id })
    if (!valid.ok) {
      await releaseConversationExecution(claim.claim.id)
      throw new FreightOperationError('Conversation changed before send; review it again.', 409, 'EXECUTION_STALE')
    }

    const refreshed = await loadFreightConversation(input.workspaceId, input.conversationId)
    const refreshedRecord = (refreshed.metadata?.freight_workflow ?? null) as FreightWorkflowRecord | null
    if (!refreshedRecord || refreshedRecord.id !== record.id || refreshedRecord.status !== 'READY_FOR_APPROVAL' || refreshedRecord.generatedArtifactId !== artifact.id) {
      await releaseConversationExecution(claim.claim.id)
      throw new FreightOperationError('The freight document changed before send; review it again.', 409, 'WORKFLOW_CHANGED')
    }
    const refreshedRecipient = refreshedRecord.request.senderEmail || refreshed.customer_id
    if (refreshedRecipient !== binding.recipient || refreshed.channel_conversation_id !== binding.emailThreadId) {
      await releaseConversationExecution(claim.claim.id)
      throw new FreightOperationError('The email recipient or thread changed before send; review it again.', 409, 'DELIVERY_TARGET_CHANGED')
    }

    const bytes = await downloadArtifactBytes(artifact.storage_path)
    if (!bytes) throw new FreightOperationError('Generated document bytes are unavailable', 500, 'ARTIFACT_BYTES_MISSING')
    const subjectRaw = String(refreshed.metadata?.subject ?? 'Freight document')
    const subject = subjectRaw.startsWith('Re:') ? subjectRaw : `Re: ${subjectRaw}`
    const approvedAt = binding.approvedAt

    await db.from('workspace_events').insert({
      workspace_id: input.workspaceId,
      type: 'freight.document.approved',
      actor_kind: 'operator',
      is_failure: false,
      subject_table: 'business_artifacts',
      subject_id: artifact.id,
      payload: {
        workflow_id: record.id,
        approved_at: approvedAt,
        approved_by_user_id: input.actor.userId,
        authority_kind: input.actor.actorKind,
        operator_id: input.actor.operatorId,
        artifact_version: binding.artifactVersion,
        recipient: binding.recipient,
        email_thread_id: binding.emailThreadId,
      },
      origin: 'app',
    })

    const sent = await sendGmailReplyWithAttachments({
      to: binding.recipient,
      subject,
      body: record.reply,
      gmailThreadId: binding.emailThreadId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      attachments: [{ filename: artifact.filename ?? 'freight-document.pdf', mimeType: artifact.detected_mime_type ?? 'application/pdf', bytes }],
    })
    providerAccepted = true
    const sentAt = new Date().toISOString()
    record = { ...record, status: 'SENT', approvedAt, sentAt }

    const { data: outbound, error: outboundError } = await db.from('unified_messages').insert({
      conversation_id: input.conversationId,
      channel_message_id: sent.gmailMessageId,
      sender_type: 'business',
      content: record.reply,
      message_type: 'file',
      sent_at: sentAt,
      status: 'sent',
      is_internal: false,
      metadata: {
        generated_by: 'caye',
        source: 'gmail',
        gmail_message_id: sent.gmailMessageId,
        gmail_thread_id: sent.threadId,
        freight_workflow_id: record.id,
        attachment_artifact_id: artifact.id,
        approved_by: input.actor.actorKind,
        approved_by_user_id: input.actor.userId,
        approved_by_operator_id: input.actor.operatorId,
      },
    }).select('id').single()
    if (outboundError || !outbound) throw new Error(`Email was sent but its durable receipt could not be recorded: ${outboundError?.message ?? 'unknown persistence failure'}`)

    await db.from('business_artifact_relations').insert({
      workspace_id: input.workspaceId,
      artifact_id: artifact.id,
      relation_type: 'sent_as_attachment_in',
      target_entity_type: 'unified_message',
      target_entity_id: outbound.id,
      label: `Sent for Dock Receipt ${record.request.dockReceiptNumber}`,
      status: 'confirmed',
      confidence: null,
      provenance: 'system_derived',
      confirmed_at: sentAt,
    })
    const { error: conversationUpdateError } = await db.from('unified_conversations').update({
      metadata: { ...refreshed.metadata, freight_workflow: record },
      human_agent_enabled: false,
      human_agent_reason: null,
      last_sender_type: 'business',
      last_business_sender_kind: 'human',
      last_message_at: sentAt,
      last_message_preview: record.reply.slice(0, 100),
    }).eq('id', input.conversationId)
    if (conversationUpdateError) throw new Error(`Email was sent but the freight workflow could not be updated: ${conversationUpdateError.message}`)

    await db.from('workspace_events').insert({
      workspace_id: input.workspaceId,
      type: 'freight.document.sent',
      actor_kind: 'operator',
      is_failure: false,
      subject_table: 'business_artifacts',
      subject_id: artifact.id,
      payload: { workflow_id: record.id, provider_message_id: sent.gmailMessageId, conversation_id: input.conversationId, approved_by_user_id: input.actor.userId, authority_kind: input.actor.actorKind },
      origin: 'app',
    })
    await completeConversationExecution(claim.claim.id, sent.gmailMessageId)
    return { outcome: 'sent', record, providerMessageId: sent.gmailMessageId }
  } catch (error) {
    const classified = classifyFreightSendFailure(providerAccepted, error)
    await resolveConversationExecutionAfterFailure(claim.claim.id, classified)
    if (classified instanceof DispatchAmbiguousError) {
      return { outcome: 'ambiguous', record, message: classified.message }
    }
    if (classified instanceof FreightOperationError) throw classified
    return { outcome: 'retryable_failure', record, message: classified instanceof Error ? classified.message : 'Send failed before provider acceptance' }
  }
}
