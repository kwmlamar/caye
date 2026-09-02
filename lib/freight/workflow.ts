import crypto from 'node:crypto'
import { buildFreightDocumentData, prepareFreightReply, renderFreightDocumentPdf } from './document'
import { rankPurchaseEvidence } from './matching'
import type { FreightDocumentData, FreightRequest, FreightWorkflowStatus, PurchaseEvidence, RankedPurchaseEvidence } from './types'

export interface FreightWorkflowRecord {
  id: string
  workspaceId: string
  conversationId: string
  requestMessageId: string
  request: FreightRequest
  status: FreightWorkflowStatus
  candidates: RankedPurchaseEvidence[]
  selectedEvidenceId: string | null
  generatedArtifactId: string | null
  reply: string | null
  approvedAt: string | null
  sentAt: string | null
}

export interface FreightWorkflowStore {
  find(workspaceId: string, conversationId: string, requestMessageId: string): Promise<FreightWorkflowRecord | null>
  save(record: FreightWorkflowRecord): Promise<void>
  recordEvent(workspaceId: string, type: string, record: FreightWorkflowRecord): Promise<void>
  persistRelation(input: { workspaceId: string; workflowId: string; requestMessageId: string; evidenceId: string; artifactId: string }): Promise<void>
}

export interface GeneratedFreightArtifact {
  id: string
  bytes: Buffer
  filename: string
  data: FreightDocumentData
}

export interface FreightArtifactWriter {
  write(input: { workspaceId: string; conversationId: string; idempotencyKey: string; filename: string; bytes: Buffer; data: FreightDocumentData }): Promise<string>
}

export interface ApprovedFreightSender {
  send(input: { workspaceId: string; conversationId: string; body: string; artifactId: string; idempotencyKey: string }): Promise<{ providerMessageId: string }>
}

export class FreightWorkflow {
  constructor(private store: FreightWorkflowStore, private artifacts: FreightArtifactWriter, private sender: ApprovedFreightSender) {}

  async discover(input: { workspaceId: string; conversationId: string; requestMessageId: string; request: FreightRequest; evidence: PurchaseEvidence[] }): Promise<FreightWorkflowRecord | null> {
    if (!input.request.isFreightDocumentRequest) return null
    const prior = await this.store.find(input.workspaceId, input.conversationId, input.requestMessageId)
    if (prior) return prior
    const safeEvidence = input.evidence.filter(e => e.workspaceId === input.workspaceId)
    const match = rankPurchaseEvidence(input.request, safeEvidence)
    const record: FreightWorkflowRecord = {
      id: crypto.createHash('sha256').update(`${input.workspaceId}:${input.conversationId}:${input.requestMessageId}`).digest('hex').slice(0, 32),
      workspaceId: input.workspaceId, conversationId: input.conversationId, requestMessageId: input.requestMessageId,
      request: input.request, status: match.status, candidates: match.candidates,
      selectedEvidenceId: match.selection?.evidence.id ?? null, generatedArtifactId: null,
      reply: null, approvedAt: null, sentAt: null,
    }
    await this.store.save(record)
    await this.store.recordEvent(input.workspaceId, 'freight.request.detected', record)
    if (match.selection) await this.store.recordEvent(input.workspaceId, 'freight.purchase_evidence.matched', record)
    return record
  }

  async generate(record: FreightWorkflowRecord, evidence: PurchaseEvidence, businessName: string): Promise<FreightWorkflowRecord> {
    if (evidence.workspaceId !== record.workspaceId) throw new Error('Purchase evidence belongs to a different workspace')
    if (record.generatedArtifactId) return record
    if (!record.candidates.some(c => c.evidence.id === evidence.id)) throw new Error('Purchase evidence is not a candidate for this workflow')
    const data = buildFreightDocumentData(businessName, record.request, evidence)
    const bytes = renderFreightDocumentPdf(data)
    const filename = `freight-${record.request.dockReceiptNumber}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '-')
    const artifactId = await this.artifacts.write({
      workspaceId: record.workspaceId, conversationId: record.conversationId,
      idempotencyKey: `freight-document:${record.id}`, filename, bytes, data,
    })
    const next = { ...record, status: 'READY_FOR_APPROVAL' as const, selectedEvidenceId: evidence.id, generatedArtifactId: artifactId, reply: prepareFreightReply(record.request) }
    await this.store.save(next)
    await this.store.recordEvent(record.workspaceId, 'freight.document.generated', next)
    return next
  }

  async approveAndSend(record: FreightWorkflowRecord, actor: { userId: string; explicitlyApproved: boolean }): Promise<FreightWorkflowRecord> {
    if (!actor.explicitlyApproved) throw new Error('Explicit owner approval is required')
    if (record.status === 'SENT') return record
    if (record.status !== 'READY_FOR_APPROVAL' || !record.generatedArtifactId || !record.selectedEvidenceId || !record.reply) throw new Error('Freight document is not ready to send')
    const artifactId = record.generatedArtifactId
    const evidenceId = record.selectedEvidenceId
    const reply = record.reply
    const approved = { ...record, approvedAt: new Date().toISOString() }
    await this.store.save(approved)
    await this.store.recordEvent(record.workspaceId, 'freight.document.approved', approved)
    await this.sender.send({ workspaceId: record.workspaceId, conversationId: record.conversationId, body: reply, artifactId, idempotencyKey: `freight-send:${record.id}` })
    const sent = { ...approved, status: 'SENT' as const, sentAt: new Date().toISOString() }
    await this.store.persistRelation({ workspaceId: sent.workspaceId, workflowId: sent.id, requestMessageId: sent.requestMessageId, evidenceId, artifactId })
    await this.store.save(sent)
    await this.store.recordEvent(sent.workspaceId, 'freight.document.sent', sent)
    return sent
  }
}
