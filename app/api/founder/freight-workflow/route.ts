import { freightReferenceLabel, freightRequestEntityId } from '@/lib/freight/types'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFreightWorkspaceAuthority } from '@/lib/freight/authorization'
import { detectFreightRequest } from '@/lib/freight/detection'
import { purchaseEvidenceFromObservation } from '@/lib/freight/evidence'
import { rankPurchaseEvidence } from '@/lib/freight/matching'
import { buildFreightDocumentData, prepareFreightReply, renderFreightDocumentPdf } from '@/lib/freight/document'
import { ingestArtifact } from '@/lib/artifacts/ingest'
import { downloadArtifactBytes, signArtifactUrl } from '@/lib/artifacts/storage'
import { sendGmailReplyWithAttachments } from '@/lib/gmail-send'
import { claimConversationExecution, completeConversationExecution, releaseConversationExecution, resolveConversationExecutionAfterFailure, validateConversationExecution } from '@/lib/conversation-execution'
import type { FreightWorkflowRecord } from '@/lib/freight/workflow'
import type { PurchaseEvidence } from '@/lib/freight/types'
import { classifyFreightSendFailure } from '@/lib/freight/send-safety'

type Conversation = { id: string; channel_type: string; channel_conversation_id: string; customer_id: string; customer_name: string | null; metadata: Record<string, unknown>; connected_accounts: { user_id: string } | Array<{ user_id: string }> }

async function context(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId'); const conversationId = req.nextUrl.searchParams.get('conversationId')
  if (!workspaceId) return { error: NextResponse.json({ error: 'workspaceId is required' }, { status: 400 }) }
  const authority = await requireFreightWorkspaceAuthority(req, workspaceId)
  if (!authority) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  const db = createServiceClient()
  if (!conversationId) return { db, workspaceId, authority, conversationId: null, conv: null }
  const { data } = await db.from('unified_conversations').select('id,channel_type,channel_conversation_id,customer_id,customer_name,metadata,connected_accounts!inner(user_id)').eq('id', conversationId).single()
  const conv = data as unknown as Conversation | null
  const account = Array.isArray(conv?.connected_accounts) ? conv?.connected_accounts[0] : conv?.connected_accounts
  if (!conv || account?.user_id !== workspaceId) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { db, conv, workspaceId, conversationId, authority }
}

async function loadEvidence(db: ReturnType<typeof createServiceClient>, workspaceId: string): Promise<PurchaseEvidence[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data } = await db.from('business_artifact_observations').select('artifact_id,content,business_artifacts!inner(filename,source_channel,received_at)').eq('workspace_id', workspaceId).in('observation_type', ['document_extraction', 'entity_observation']).is('superseded_at', null).gte('created_at', since).order('created_at', { ascending: false }).limit(100)
  return (data ?? []).flatMap((row: any) => {
    const content = row.content && typeof row.content === 'object' ? row.content as Record<string, unknown> : {}
    const looksPurchase = ['vendor','seller','merchant','total','order_number','receipt_number','invoice_number','line_items'].some(k => k in content)
    if (!looksPurchase) return []
    const artifact = Array.isArray(row.business_artifacts) ? row.business_artifacts[0] : row.business_artifacts
    return [purchaseEvidenceFromObservation({ workspaceId, artifactId: String(row.artifact_id), source: String(artifact?.source_channel ?? '').startsWith('email_') ? 'email' : 'artifact', filename: artifact?.filename ?? null, content })]
  })
}

async function analyze(db: ReturnType<typeof createServiceClient>, conv: Conversation, workspaceId: string): Promise<FreightWorkflowRecord | { isFreightDocumentRequest: false }> {
  const existing = (conv.metadata?.freight_workflow ?? null) as FreightWorkflowRecord | null
  if (existing?.workspaceId === workspaceId && existing.conversationId === conv.id) return existing
  const { data: message } = await db.from('unified_messages').select('id,content,sent_at,metadata').eq('conversation_id', conv.id).eq('sender_type', 'customer').eq('is_internal', false).order('sent_at', { ascending: false }).limit(1).maybeSingle()
  if (!message) return { isFreightDocumentRequest: false }
  const meta = (message.metadata ?? {}) as Record<string, unknown>
  const request = detectFreightRequest({ subject: String(meta.subject ?? conv.metadata?.subject ?? ''), body: message.content, from: String(meta.from ?? conv.metadata?.from ?? conv.customer_id), receivedAt: message.sent_at })
  if (!request.isFreightDocumentRequest) return { isFreightDocumentRequest: false }
  const match = rankPurchaseEvidence(request, await loadEvidence(db, workspaceId))
  const record: FreightWorkflowRecord = { id: `freight:${message.id}`, workspaceId, conversationId: conv.id, requestMessageId: message.id, request, status: match.status, candidates: match.candidates, selectedEvidenceId: match.selection?.evidence.id ?? null, generatedArtifactId: null, reply: null, approvedAt: null, sentAt: null }
  await db.from('unified_conversations').update({ metadata: { ...conv.metadata, freight_workflow: record }, human_agent_enabled: true, human_agent_reason: `Freight document requested for ${freightReferenceLabel(request.reference)} — review required` }).eq('id', conv.id)
  // dock_receipt_number is kept for any existing reader of this payload shape -- it is the derived
  // projection, so it is already null for a non-dock-receipt (e.g. TWINex warehouse-number) request.
  // reference is the actual source of truth ({ kind, value }) and covers every forwarder/kind.
  await db.from('workspace_events').insert({ workspace_id: workspaceId, type: 'freight.request.detected', actor_kind: 'system', is_failure: false, subject_table: 'unified_conversations', subject_id: conv.id, payload: { workflow_id: record.id, request_message_id: message.id, dock_receipt_number: request.dockReceiptNumber, reference: request.reference, evidence: request.evidence }, origin: 'app' })
  if (match.selection) await db.from('workspace_events').insert({ workspace_id: workspaceId, type: 'freight.purchase_evidence.matched', actor_kind: 'system', is_failure: false, subject_table: 'business_artifacts', subject_id: match.selection.evidence.id, payload: { workflow_id: record.id, confidence: match.selection.confidence, reasons: match.selection.reasons }, origin: 'app' })
  return record
}

export async function GET(req: NextRequest) {
  const ctx = await context(req); if ('error' in ctx) return ctx.error
  if (!ctx.conversationId || !ctx.conv) {
    const { data } = await ctx.db.from('unified_conversations')
      .select('id,customer_name,customer_id,metadata,last_message_at,connected_accounts!inner(user_id)')
      .eq('connected_accounts.user_id', ctx.workspaceId)
      .eq('channel_type', 'gmail')
      .order('last_message_at', { ascending: false })
      .limit(50)
    return NextResponse.json({ conversations: (data ?? []).map((row: any) => ({ id: row.id, customerName: row.customer_name, customerId: row.customer_id, subject: row.metadata?.subject ?? null, lastMessageAt: row.last_message_at, freightStatus: row.metadata?.freight_workflow?.status ?? null })) })
  }
  const state = await analyze(ctx.db!, ctx.conv!, ctx.workspaceId!)
  if (req.nextUrl.searchParams.get('artifact') === '1') {
    if ('isFreightDocumentRequest' in state || !state.generatedArtifactId) return NextResponse.json({ error: 'Freight document not found' }, { status: 404 })
    const { data: artifact } = await ctx.db.from('business_artifacts').select('id,storage_path,filename,detected_mime_type').eq('id', state.generatedArtifactId).eq('workspace_id', ctx.workspaceId).eq('storage_state', 'stored').maybeSingle()
    if (!artifact) return NextResponse.json({ error: 'Freight document not found' }, { status: 404 })
    const url = await signArtifactUrl(artifact.storage_path)
    return url ? NextResponse.json({ artifact: { id: artifact.id, filename: artifact.filename, mimeType: artifact.detected_mime_type, url } }) : NextResponse.json({ error: 'Could not prepare that file right now — try again.' }, { status: 502 })
  }
  return NextResponse.json('isFreightDocumentRequest' in state ? state : { ...state, isFreightDocumentRequest: true })
}

export async function POST(req: NextRequest) {
  const ctx = await context(req); if ('error' in ctx) return ctx.error
  if (!ctx.conversationId || !ctx.conv) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  const { db, conv, workspaceId, conversationId, authority } = ctx
  const body = await req.json().catch(() => ({})) as { action?: string; evidenceId?: string }
  const analyzed = await analyze(db, conv, workspaceId)
  if ('isFreightDocumentRequest' in analyzed) return NextResponse.json({ error: 'This is not a freight document request' }, { status: 409 })
  let record = analyzed
  if (body.action === 'generate') {
    if (record.generatedArtifactId) return NextResponse.json({ ...record, isFreightDocumentRequest: true })
    const selected = record.candidates.find(c => c.evidence.id === body.evidenceId)?.evidence
    if (!selected || selected.workspaceId !== workspaceId) return NextResponse.json({ error: 'Receipt candidate not found in this workspace' }, { status: 404 })
    const { data: customer } = await db.from('customers').select('business_name').eq('id', workspaceId).maybeSingle()
    const document = buildFreightDocumentData(customer?.business_name ?? 'Business', record.request, selected)
    const bytes = renderFreightDocumentPdf(document)
    // document.reference is guaranteed non-null here -- buildFreightDocumentData throws before
    // constructing a FreightDocumentData without one. Sanitize its value into the filename so a
    // TWINex warehouse number (or any future reference kind) produces a safe, non-"null" filename.
    const filename = `freight-${document.reference.value}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '-')
    const ingested = await ingestArtifact({ workspaceId, sourceChannel: 'dashboard', bytes, declaredMimeType: 'application/pdf', filename, providerAttachmentId: `freight-document:${record.id}`, conversationId, origin: 'caye_generated', senderLabel: 'Caye freight workflow' })
    if (!ingested.ok) return NextResponse.json({ error: ingested.error }, { status: 500 })
    await db.from('business_artifact_observations').insert({ artifact_id: ingested.artifact.id, workspace_id: workspaceId, observation_type: 'document_extraction', modality: 'document', content: { kind: 'freight_document', data: document, source_evidence_ids: document.sourceEvidence.map(e => e.id) }, confidence: null, provenance_status: 'extracted', derived_by: 'system:freight-document-v1' })
    const referenceLabel = freightReferenceLabel(record.request.reference)
    await db.from('business_artifact_relations').insert([{ workspace_id: workspaceId, artifact_id: ingested.artifact.id, relation_type: 'generated_from', target_entity_type: 'business_artifact', target_entity_id: selected.id, label: `Source purchase evidence for ${referenceLabel}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: new Date().toISOString() }, { workspace_id: workspaceId, artifact_id: ingested.artifact.id, relation_type: 'answers_request', target_entity_type: 'unified_message', target_entity_id: record.requestMessageId, label: `Freight request ${referenceLabel}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: new Date().toISOString() }, { workspace_id: workspaceId, artifact_id: ingested.artifact.id, relation_type: 'represents', target_entity_type: 'freight_request', target_entity_id: freightRequestEntityId(record.id), label: referenceLabel, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: new Date().toISOString() }])
    record = { ...record, status: 'READY_FOR_APPROVAL', selectedEvidenceId: selected.id, generatedArtifactId: ingested.artifact.id, reply: prepareFreightReply(record.request) }
    await db.from('unified_conversations').update({ metadata: { ...conv.metadata, freight_workflow: record } }).eq('id', conversationId)
    // See the comment on the freight.request.detected event above: dock_receipt_number is the
    // derived (King-Ocean-only) projection kept for existing readers, reference is the source of truth.
    await db.from('workspace_events').insert({ workspace_id: workspaceId, type: 'freight.document.generated', actor_kind: 'caye', is_failure: false, subject_table: 'business_artifacts', subject_id: ingested.artifact.id, payload: { workflow_id: record.id, dock_receipt_number: record.request.dockReceiptNumber, reference: record.request.reference, source_artifact_id: selected.id, unresolved_fields: document.unresolvedFields }, origin: 'app' })
    return NextResponse.json({ ...record, isFreightDocumentRequest: true })
  }
  if (body.action !== 'approve_send') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  if (record.status === 'SENT') return NextResponse.json({ ...record, isFreightDocumentRequest: true })
  if (record.status !== 'READY_FOR_APPROVAL' || !record.generatedArtifactId || !record.reply) return NextResponse.json({ error: 'Document is not ready for approval' }, { status: 409 })
  if (conv.channel_type !== 'gmail') return NextResponse.json({ error: 'Attachment sending is currently supported for connected Gmail threads only. No email was sent.' }, { status: 422 })
  const claim = await claimConversationExecution({ workspaceId, conversationId, holder: 'human_manual', idempotencyKey: `freight-send:${record.id}`, reason: 'owner approved freight document attachment', leaseSeconds: 120 })
  if (!claim.ok) return NextResponse.json({ error: `Conversation is currently handled by ${claim.blockedBy}` }, { status: 409 })
  let providerAccepted = false
  try {
    const valid = await validateConversationExecution({ claimId: claim.claim.id }); if (!valid.ok) { await releaseConversationExecution(claim.claim.id); return NextResponse.json({ error: 'Conversation changed before send; reload and review again.' }, { status: 409 }) }
    const { data: artifact } = await db.from('business_artifacts').select('id,workspace_id,storage_path,filename,detected_mime_type').eq('id', record.generatedArtifactId).eq('workspace_id', workspaceId).eq('storage_state', 'stored').single()
    if (!artifact) throw new Error('Generated document is unavailable in this workspace')
    const bytes = await downloadArtifactBytes(artifact.storage_path); if (!bytes) throw new Error('Generated document bytes are unavailable')
    const subjectRaw = String(conv.metadata?.subject ?? 'Freight document'); const subject = subjectRaw.startsWith('Re:') ? subjectRaw : `Re: ${subjectRaw}`
    const reply = record.reply
    const approvedAt = new Date().toISOString()
    await db.from('workspace_events').insert({ workspace_id: workspaceId, type: 'freight.document.approved', actor_kind: 'operator', is_failure: false, subject_table: 'business_artifacts', subject_id: artifact.id, payload: { workflow_id: record.id, approved_at: approvedAt, approved_by_user_id: authority.userId, authority_kind: authority.actorKind }, origin: 'app' })
    const sent = await sendGmailReplyWithAttachments({ to: conv.customer_id, subject, body: reply, gmailThreadId: conv.channel_conversation_id, conversationId, workspaceId, attachments: [{ filename: artifact.filename ?? 'freight-document.pdf', mimeType: artifact.detected_mime_type ?? 'application/pdf', bytes }] })
    providerAccepted = true
    const sentAt = new Date().toISOString(); record = { ...record, status: 'SENT', approvedAt, sentAt }
    const { data: outbound, error: outboundError } = await db.from('unified_messages').insert({ conversation_id: conversationId, channel_message_id: sent.gmailMessageId, sender_type: 'business', content: reply, message_type: 'file', sent_at: sentAt, status: 'sent', is_internal: false, metadata: { generated_by: 'caye', source: 'gmail', gmail_message_id: sent.gmailMessageId, gmail_thread_id: sent.threadId, freight_workflow_id: record.id, attachment_artifact_id: artifact.id, approved_by: authority.actorKind, approved_by_user_id: authority.userId } }).select('id').single()
    if (outboundError || !outbound) throw new Error(`Email was sent but its durable receipt could not be recorded: ${outboundError?.message ?? 'unknown persistence failure'}`)
    await db.from('business_artifact_relations').insert({ workspace_id: workspaceId, artifact_id: artifact.id, relation_type: 'sent_as_attachment_in', target_entity_type: 'unified_message', target_entity_id: outbound.id, label: `Sent for ${freightReferenceLabel(record.request.reference)}`, status: 'confirmed', confidence: null, provenance: 'system_derived', confirmed_at: sentAt })
    await db.from('unified_conversations').update({ metadata: { ...conv.metadata, freight_workflow: record }, human_agent_enabled: false, human_agent_reason: null, last_sender_type: 'business', last_business_sender_kind: 'human', last_message_at: sentAt, last_message_preview: reply.slice(0, 100) }).eq('id', conversationId)
    await db.from('workspace_events').insert({ workspace_id: workspaceId, type: 'freight.document.sent', actor_kind: 'operator', is_failure: false, subject_table: 'business_artifacts', subject_id: artifact.id, payload: { workflow_id: record.id, provider_message_id: sent.gmailMessageId, conversation_id: conversationId, approved_by_user_id: authority.userId, authority_kind: authority.actorKind }, origin: 'app' })
    await completeConversationExecution(claim.claim.id, sent.gmailMessageId)
    return NextResponse.json({ ...record, isFreightDocumentRequest: true })
  } catch (error) {
    const classified = classifyFreightSendFailure(providerAccepted, error)
    await resolveConversationExecutionAfterFailure(claim.claim.id, classified)
    return NextResponse.json({ error: classified instanceof Error ? classified.message : 'Send failed or delivery is uncertain' }, { status: 502 })
  }
}
