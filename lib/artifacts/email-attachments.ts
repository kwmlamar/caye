import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { ingestArtifact } from './ingest'
import { processArtifact } from './process'
import { analyzeEmailDocument, isTrustedPurchaseEvidenceType, type EmailDocumentType } from './email-evidence-semantics'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_LAZY_MESSAGES = 20
const MAX_ATTACHMENTS_PER_MESSAGE = 20

export type EmailAttachmentProvider = 'gmail' | 'zoho'

export interface NormalizedEmailAttachmentDescriptor {
  workspaceId: string
  connectedAccountId: string
  provider: EmailAttachmentProvider
  providerMessageId: string
  providerThreadId: string | null
  /**
   * The provider's own handle for fetching these bytes. Gmail mints a fresh
   * one on every messages.get, so it identifies a FETCH, not an attachment —
   * never use it as a dedup key. See attachmentPartPath.
   */
  providerAttachmentId: string
  /**
   * Position of this attachment in the message's MIME tree ('0.1.0'), which
   * is stable for the life of the (immutable) message. This, not
   * providerAttachmentId, is the attachment's durable identity.
   */
  attachmentPartPath: string
  filename: string | null
  mimeType: string | null
  size: number | null
  sender: string | null
  subject: string | null
  receivedAt: string | null
  conversationId: string | null
  unifiedMessageId: string | null
}

export interface GmailMimePart {
  mimeType?: string
  filename?: string
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailMimePart[]
}

export interface GmailAttachmentMessage {
  id: string
  threadId?: string
  internalDate?: string
  payload?: { headers?: Array<{ name: string; value: string }>; parts?: GmailMimePart[]; mimeType?: string; filename?: string; body?: GmailMimePart['body'] }
}

function gmailHeader(message: GmailAttachmentMessage, name: string): string | null {
  const value = message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value?.trim()
  return value || null
}

/** Pure metadata normalization. No bytes are fetched here. */
export function gmailAttachmentDescriptors(input: {
  workspaceId: string
  connectedAccountId: string
  message: GmailAttachmentMessage
  conversationId?: string | null
  unifiedMessageId?: string | null
}): NormalizedEmailAttachmentDescriptor[] {
  const result: NormalizedEmailAttachmentDescriptor[] = []
  const walk = (part: GmailMimePart | undefined, partPath: string) => {
    if (!part) return
    const attachmentId = part.body?.attachmentId
    if (attachmentId) {
      result.push({
        workspaceId: input.workspaceId,
        connectedAccountId: input.connectedAccountId,
        provider: 'gmail',
        providerMessageId: input.message.id,
        providerThreadId: input.message.threadId || null,
        providerAttachmentId: attachmentId,
        attachmentPartPath: partPath,
        filename: part.filename?.trim() || null,
        mimeType: part.mimeType?.trim() || null,
        size: typeof part.body?.size === 'number' ? part.body.size : null,
        sender: gmailHeader(input.message, 'From'),
        subject: gmailHeader(input.message, 'Subject'),
        receivedAt: input.message.internalDate ? new Date(Number(input.message.internalDate)).toISOString() : null,
        conversationId: input.conversationId ?? null,
        unifiedMessageId: input.unifiedMessageId ?? null,
      })
    }
    part.parts?.forEach((child, index) => walk(child, `${partPath}.${index}`))
  }
  walk(input.message.payload, '0')
  return result.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
}

/**
 * The attachment's durable identity, and ingestArtifact's ONLY dedup key —
 * it compares this string alone, never content_sha256. Every component must
 * therefore be stable across re-fetches of the same message.
 *
 * This deliberately does NOT include descriptor.providerAttachmentId. Gmail
 * mints a fresh attachmentId on every messages.get of the same message, so
 * including it meant the 5-minute poll saw each attachment as brand new,
 * re-ingested it, and re-ran document understanding on it — ~419 duplicate
 * extractions of two real ODS emails in 24h. The MIME part path identifies
 * the attachment within the message and does not change between fetches.
 */
export function canonicalEmailAttachmentId(descriptor: NormalizedEmailAttachmentDescriptor): string {
  return `${descriptor.connectedAccountId}:${descriptor.providerMessageId}:${descriptor.attachmentPartPath}`
}

function decodeBase64UrlBytes(data: string): Buffer {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64')
}

async function validateConnectedAccount(descriptor: NormalizedEmailAttachmentDescriptor): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', descriptor.connectedAccountId)
    .eq('user_id', descriptor.workspaceId)
    .eq('channel_type', descriptor.provider)
    .eq('is_active', true)
    .maybeSingle()
  if (error || !data) throw new Error('email attachment account/workspace validation failed')
  return data as Record<string, unknown>
}

export async function fetchGmailAttachmentBytes(descriptor: NormalizedEmailAttachmentDescriptor, accessToken: string): Promise<Buffer> {
  if (descriptor.provider !== 'gmail') throw new Error('descriptor is not Gmail')
  if (!descriptor.providerMessageId || !descriptor.providerAttachmentId) throw new Error('missing Gmail attachment identity')
  const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(descriptor.providerMessageId)}/attachments/${encodeURIComponent(descriptor.providerAttachmentId)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Gmail attachment fetch failed (${res.status})`)
  const json = await res.json() as { data?: string; size?: number }
  if (!json.data) throw new Error('Gmail attachment response had no bytes')
  return decodeBase64UrlBytes(json.data)
}

/**
 * Zoho's current Caye poll path fetches message bodies but has no verified
 * attachment-list + attachment-download contract. We deliberately fail closed
 * rather than guessing a URL or treating metadata as durable evidence.
 */
export async function fetchZohoAttachmentBytes(_descriptor: NormalizedEmailAttachmentDescriptor): Promise<Buffer> {
  throw new Error('ZOHO_ATTACHMENT_FETCH_UNSUPPORTED: no verified Zoho attachment byte path is wired')
}

async function insertSystemRelation(input: {
  workspaceId: string
  artifactId: string
  relationType: string
  targetEntityType: string
  targetEntityId: string
  status?: 'candidate' | 'confirmed'
  sourceObservationId?: string | null
}): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('business_artifact_relations').insert({
    workspace_id: input.workspaceId,
    artifact_id: input.artifactId,
    relation_type: input.relationType,
    target_entity_type: input.targetEntityType,
    target_entity_id: input.targetEntityId,
    label: null,
    status: input.status ?? 'confirmed',
    confidence: null,
    provenance: 'system_derived',
    source_observation_id: input.sourceObservationId ?? null,
  })
  // Relation writes are idempotent under existing unique constraints. A replay
  // should keep the canonical artifact, not fail the whole ingestion.
  if (error && error.code !== '23505') throw new Error(`artifact relation failed: ${error.message}`)
}

async function semanticizeArtifact(input: { descriptor: NormalizedEmailAttachmentDescriptor; artifactId: string }): Promise<{ documentType: EmailDocumentType; observationId: string | null }> {
  const supabase = createServiceClient()
  // Force one synchronous understanding attempt so a newly fetched PDF can be
  // used by the freight workflow in the same request. The durable queue created
  // by ingestArtifact remains the retry path and processArtifact's CAS keeps the
  // two callers safe.
  await processArtifact(input.artifactId)

  const { data: observations } = await supabase
    .from('business_artifact_observations')
    .select('observation_type, content')
    .eq('workspace_id', input.descriptor.workspaceId)
    .eq('artifact_id', input.artifactId)
    .is('superseded_at', null)

  let extractedText = ''
  for (const observation of observations ?? []) {
    const content = (observation.content ?? {}) as Record<string, unknown>
    if (observation.observation_type === 'document_extraction' && typeof content.full_text === 'string') extractedText += `\n${content.full_text}`
    if (observation.observation_type === 'visible_text' && typeof content.text === 'string') extractedText += `\n${content.text}`
  }

  const semantics = analyzeEmailDocument({ filename: input.descriptor.filename, subject: input.descriptor.subject, text: extractedText })
  const purchase = semantics.purchase
  const dock = semantics.dock_receipt
  const flat = <T>(field: { value: T | null } | undefined) => field?.value ?? null
  const fieldProvenance = purchase
    ? Object.fromEntries(Object.entries(purchase).map(([key, field]) => [key, field.provenance]))
    : dock
      ? Object.fromEntries(Object.entries(dock).map(([key, field]) => [key, field.provenance]))
      : {}

  const content: Record<string, unknown> = {
    document_type: semantics.document_type,
    classification_confidence: semantics.confidence,
    classification_provenance: semantics.classification_provenance,
    field_provenance: fieldProvenance,
    source_message_id: input.descriptor.providerMessageId,
    source_thread_id: input.descriptor.providerThreadId,
    filename: input.descriptor.filename,
  }
  if (purchase) {
    content.vendor = flat(purchase.vendor)
    content.purchase_date = flat(purchase.purchase_date)
    content.invoice_number = flat(purchase.invoice_number)
    content.receipt_number = flat(purchase.receipt_number)
    content.order_number = flat(purchase.order_number)
    content.po_number = flat(purchase.po_number)
    content.line_items = purchase.line_items.value ?? []
    content.subtotal = flat(purchase.subtotal)
    content.tax = flat(purchase.tax)
    content.shipping = flat(purchase.shipping)
    content.total = flat(purchase.total)
    content.currency = flat(purchase.currency)
    content.purchaser = flat(purchase.purchaser)
    content.shipping_address = flat(purchase.shipping_address)
  }
  if (dock) {
    content.dock_receipt_number = flat(dock.dock_receipt_number)
    content.freight_provider = flat(dock.freight_provider)
    content.shipment_reference = flat(dock.shipment_reference)
    content.destination = flat(dock.destination)
    content.commodity_description = flat(dock.commodity_description)
    content.consolidation = flat(dock.consolidation)
    content.dates = dock.dates.value ?? []
    content.shipment_identifiers = dock.shipment_identifiers.value ?? []
  }

  const modelVersion = 'email-evidence-v1'
  const { data: existing } = await supabase
    .from('business_artifact_observations')
    .select('id')
    .eq('artifact_id', input.artifactId)
    .eq('observation_type', 'entity_observation')
    .eq('model_version', modelVersion)
    .is('superseded_at', null)
    .maybeSingle()
  if (existing?.id) return { documentType: semantics.document_type, observationId: String(existing.id) }

  const { data: inserted, error } = await supabase.from('business_artifact_observations').insert({
    artifact_id: input.artifactId,
    workspace_id: input.descriptor.workspaceId,
    observation_type: 'entity_observation',
    modality: 'document',
    content,
    confidence: semantics.confidence,
    provenance_status: extractedText ? 'extracted' : 'observed',
    derived_by: 'system:email-evidence-v1',
    model_version: modelVersion,
  }).select('id').single()
  if (error || !inserted) throw new Error(`email evidence observation failed: ${error?.message ?? 'insert failed'}`)
  return { documentType: semantics.document_type, observationId: String(inserted.id) }
}

export async function ingestNormalizedEmailAttachment(input: {
  descriptor: NormalizedEmailAttachmentDescriptor
  accessToken?: string
  bytes?: Buffer
}): Promise<{ artifactId: string; documentType: EmailDocumentType; deduped: boolean }> {
  const account = await validateConnectedAccount(input.descriptor)
  let bytes = input.bytes
  if (!bytes) {
    if (input.descriptor.provider === 'gmail') {
      const token = input.accessToken || String(account.access_token || '')
      if (!token) throw new Error('missing Gmail access token')
      bytes = await fetchGmailAttachmentBytes(input.descriptor, token)
    } else {
      bytes = await fetchZohoAttachmentBytes(input.descriptor)
    }
  }

  const canonicalProviderId = canonicalEmailAttachmentId(input.descriptor)
  const ingested = await ingestArtifact({
    workspaceId: input.descriptor.workspaceId,
    sourceChannel: input.descriptor.provider === 'gmail' ? 'email_gmail' : 'email_zoho',
    bytes,
    declaredMimeType: input.descriptor.mimeType,
    filename: input.descriptor.filename,
    providerAttachmentId: canonicalProviderId,
    conversationId: input.descriptor.conversationId,
    unifiedMessageId: input.descriptor.unifiedMessageId,
    senderLabel: input.descriptor.sender,
    origin: 'external',
    receivedAt: input.descriptor.receivedAt ? new Date(input.descriptor.receivedAt) : new Date(),
  })
  if (!ingested.ok) throw new Error(`artifact ingestion failed: ${ingested.error}`)

  if (input.descriptor.unifiedMessageId) {
    await insertSystemRelation({ workspaceId: input.descriptor.workspaceId, artifactId: ingested.artifact.id, relationType: 'attached_to', targetEntityType: 'unified_message', targetEntityId: input.descriptor.unifiedMessageId })
  }
  if (input.descriptor.conversationId) {
    await insertSystemRelation({ workspaceId: input.descriptor.workspaceId, artifactId: ingested.artifact.id, relationType: 'belongs_to_thread', targetEntityType: 'unified_conversation', targetEntityId: input.descriptor.conversationId })
  }

  const semantic = await semanticizeArtifact({ descriptor: input.descriptor, artifactId: ingested.artifact.id })
  return { artifactId: ingested.artifact.id, documentType: semantic.documentType, deduped: ingested.deduped }
}

export async function relateEmailArtifactToFreightRequest(input: { workspaceId: string; artifactId: string; freightRequestId: string; documentType: EmailDocumentType; sourceObservationId?: string | null }): Promise<void> {
  if (input.documentType === 'dock_receipt' || input.documentType === 'freight_document' || input.documentType === 'freight_invoice') {
    await insertSystemRelation({ workspaceId: input.workspaceId, artifactId: input.artifactId, relationType: 'evidence_for', targetEntityType: 'freight_request', targetEntityId: input.freightRequestId, status: 'candidate', sourceObservationId: input.sourceObservationId })
    return
  }
  if (isTrustedPurchaseEvidenceType(input.documentType)) {
    await insertSystemRelation({ workspaceId: input.workspaceId, artifactId: input.artifactId, relationType: 'candidate_purchase_evidence_for', targetEntityType: 'freight_request', targetEntityId: input.freightRequestId, status: 'candidate', sourceObservationId: input.sourceObservationId })
  }
  // quote/packing_slip/unrelated/unknown deliberately create no purchase relation.
}

/** Bounded historical Gmail fetch. Caller supplies known message ids; no mailbox scan. */
export async function lazyFetchGmailAttachments(input: { workspaceId: string; connectedAccountId: string; messageIds: string[]; accessToken: string }): Promise<Array<{ messageId: string; artifactIds: string[] }>> {
  if (input.messageIds.length > MAX_LAZY_MESSAGES) throw new Error(`lazy Gmail fetch is bounded to ${MAX_LAZY_MESSAGES} messages`)
  const validationDescriptor: NormalizedEmailAttachmentDescriptor = {
    workspaceId: input.workspaceId, connectedAccountId: input.connectedAccountId, provider: 'gmail', providerMessageId: input.messageIds[0] || 'validation', providerThreadId: null, providerAttachmentId: 'validation', attachmentPartPath: '0', filename: null, mimeType: null, size: null, sender: null, subject: null, receivedAt: null, conversationId: null, unifiedMessageId: null,
  }
  await validateConnectedAccount(validationDescriptor)
  const results: Array<{ messageId: string; artifactIds: string[] }> = []
  const supabase = createServiceClient()
  for (const messageId of input.messageIds) {
    const res = await fetch(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { Authorization: `Bearer ${input.accessToken}` } })
    if (!res.ok) throw new Error(`Gmail message fetch failed (${res.status}) for ${messageId}`)
    const message = await res.json() as GmailAttachmentMessage
    const { data: unified } = await supabase.from('unified_messages').select('id, conversation_id').eq('channel_message_id', messageId).maybeSingle()
    const descriptors = gmailAttachmentDescriptors({ workspaceId: input.workspaceId, connectedAccountId: input.connectedAccountId, message, conversationId: unified?.conversation_id ?? null, unifiedMessageId: unified?.id ?? null })
    const artifactIds: string[] = []
    for (const descriptor of descriptors) {
      const ingested = await ingestNormalizedEmailAttachment({ descriptor, accessToken: input.accessToken })
      artifactIds.push(ingested.artifactId)
    }
    results.push({ messageId, artifactIds })
  }
  return results
}
