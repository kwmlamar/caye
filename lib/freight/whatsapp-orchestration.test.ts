import { describe, expect, it } from 'vitest'
import type { FreightWorkflowRecord } from './workflow'
import { artifactVersion, bindFreightApproval, classifyFreightOwnerIntent, freightOwnerSummary, resolveFreightReferent, validateFreightApproval } from './whatsapp-orchestration'

function workflow(id: string, dock: string, status: FreightWorkflowRecord['status'] = 'READY_FOR_APPROVAL'): FreightWorkflowRecord {
  return {
    id, workspaceId: 'ods', conversationId: `conv-${id}`, requestMessageId: `msg-${id}`,
    request: { isFreightDocumentRequest: true, evidence: [], freightProvider: 'King Ocean', senderName: 'Nicole', senderEmail: 'nicole@example.test', dockReceiptNumber: dock, shipmentReference: null, requestedDocument: 'invoice', consolidationMentioned: false, destination: null, commodities: [], requestedAt: '2026-08-29T12:00:00Z' },
    status,
    candidates: [{ evidence: { id: `receipt-${id}`, workspaceId: 'ods', source: 'artifact', vendor: 'Home Depot', purchaseDate: '2026-08-29', referenceNumbers: [dock], orderNumber: null, receiptNumber: `HD-${id}`, poNumber: null, lines: [], subtotal: 800, tax: 42.17, shipping: null, total: 842.17, currency: 'USD', purchaser: null, shippingAddress: null, filename: 'receipt.pdf', provenance: [] }, score: 100, confidence: 'HIGH', reasons: ['exact reference'] }],
    selectedEvidenceId: `receipt-${id}`, generatedArtifactId: `artifact-${id}`, reply: 'Attached.', approvedAt: null, sentAt: null,
  }
}
const ref = (w: FreightWorkflowRecord) => ({ workflow: w, providerLabel: 'King Ocean', recipient: 'nicole@example.test', emailThreadId: `thread-${w.id}`, artifactVersion: 'v1' })

describe('WhatsApp freight orchestration', () => {
  it('recognizes natural owner intents without command syntax', () => {
    expect(classifyFreightOwnerIntent('handle that king ocean one')).toBe('handle')
    expect(classifyFreightOwnerIntent('send it')).toBe('send')
    expect(classifyFreightOwnerIntent("don't send it yet")).toBe('hold')
    expect(classifyFreightOwnerIntent("that's the wrong Home Depot receipt")).toBe('reject_evidence')
    expect(classifyFreightOwnerIntent('show me')).toBe('show')
  })

  it('resolves one workspace-local referent and never leaks cross-workspace state', () => {
    const a = workflow('a', 'DR-12345')
    const foreign = { ...workflow('b', 'DR-99999'), workspaceId: 'other' }
    expect(resolveFreightReferent({ workspaceId: 'ods', text: 'handle that king ocean one', referents: [ref(a), ref(foreign)] })).toMatchObject({ kind: 'resolved', referent: { workflow: { id: 'a' } } })
  })

  it('requires disambiguation when send it could name two prepared artifacts', () => {
    const result = resolveFreightReferent({ workspaceId: 'ods', text: 'send it', referents: [ref(workflow('a', 'DR-1')), ref(workflow('b', 'DR-2'))] })
    expect(result.kind).toBe('ambiguous')
  })

  it('uses active conversational referent for terse follow-up', () => {
    const result = resolveFreightReferent({ workspaceId: 'ods', text: 'send it', activeWorkflowId: 'b', referents: [ref(workflow('a', 'DR-1')), ref(workflow('b', 'DR-2'))] })
    expect(result).toMatchObject({ kind: 'resolved', referent: { workflow: { id: 'b' } } })
  })

  it('binds approval to exact artifact/version/recipient/thread/actor', () => {
    const version = artifactVersion({ artifactId: 'artifact-a', bytesHash: 'hash-1' })
    const approval = bindFreightApproval({ workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: version, recipient: 'nicole@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, approvedAt: '2026-09-02T20:00:00Z' })
    expect(validateFreightApproval(approval, { workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: version, recipient: 'nicole@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, now: '2026-09-02T20:05:00Z' })).toEqual({ valid: true })
    expect(validateFreightApproval(approval, { workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: 'changed', recipient: 'nicole@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, now: '2026-09-02T20:05:00Z' })).toEqual({ valid: false, reason: 'artifact_changed' })
    expect(validateFreightApproval(approval, { workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: version, recipient: 'other@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, now: '2026-09-02T20:05:00Z' })).toEqual({ valid: false, reason: 'delivery_target_changed' })
  })

  it('invalidates approval after a newer conflicting instruction', () => {
    const approval = bindFreightApproval({ workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: 'v1', recipient: 'nicole@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, approvedAt: '2026-09-02T20:00:00Z' })
    expect(validateFreightApproval(approval, { workspaceId: 'ods', workflowId: 'a', artifactId: 'artifact-a', artifactVersion: 'v1', recipient: 'nicole@example.test', emailThreadId: 'thread-a', actorOperatorId: 7, conflictingInstructionAfter: '2026-09-02T20:01:00Z', now: '2026-09-02T20:02:00Z' })).toEqual({ valid: false, reason: 'newer_conflicting_instruction' })
  })

  it('keeps human-facing summary short and hides internal taxonomy', () => {
    const text = freightOwnerSummary(ref(workflow('a', 'DR-12345')))
    expect(text).toContain('Home Depot')
    expect(text).toContain('842.17')
    expect(text).toContain('Want me to send it?')
    expect(text).not.toMatch(/HIGH|READY_FOR_APPROVAL|artifact_id|workflow_id/)
  })
})
