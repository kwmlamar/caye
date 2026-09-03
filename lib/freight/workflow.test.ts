import { describe, expect, it } from 'vitest'
import { KING_OCEAN_FIXTURE, TWINEX_FIXTURE } from './fixture'
import { FreightWorkflow, type FreightWorkflowRecord, type FreightWorkflowStore } from './workflow'

function harness() {
  let record: FreightWorkflowRecord | null = null
  const events: string[] = []; const relations: unknown[] = []; const sends: unknown[] = []; const writes: unknown[] = []
  const store: FreightWorkflowStore = {
    async find() { return record }, async save(r) { record = r },
    async recordEvent(_w, type) { events.push(type) }, async persistRelation(r) { relations.push(r) },
  }
  const workflow = new FreightWorkflow(store, { async write(input) { writes.push(input); return 'artifact-generated-1' } }, { async send(input) { sends.push(input); return { providerMessageId: 'provider-1' } } })
  return { workflow, events, relations, sends, writes, current: () => record! }
}

describe('freight workflow orchestration', () => {
  it('runs the sanitized end-to-end fixture but never sends before approval', async () => {
    const h = harness()
    const discovered = await h.workflow.discover({ workspaceId: 'workspace-ods-fixture', conversationId: 'conv-1', requestMessageId: 'msg-request-1', request: KING_OCEAN_FIXTURE.request, evidence: [KING_OCEAN_FIXTURE.evidence] })
    expect(discovered?.status).toBe('MATCH_FOUND')
    const ready = await h.workflow.generate(discovered!, KING_OCEAN_FIXTURE.evidence, 'ODS Construction')
    expect(ready.status).toBe('READY_FOR_APPROVAL')
    expect(h.sends).toHaveLength(0)
    expect(h.events).toEqual(['freight.request.detected', 'freight.purchase_evidence.matched', 'freight.document.generated'])
  })

  it('requires explicit approval and records relationship/event after send', async () => {
    const h = harness()
    const found = (await h.workflow.discover({ workspaceId: 'workspace-ods-fixture', conversationId: 'conv-1', requestMessageId: 'msg-request-1', request: KING_OCEAN_FIXTURE.request, evidence: [KING_OCEAN_FIXTURE.evidence] }))!
    const ready = await h.workflow.generate(found, KING_OCEAN_FIXTURE.evidence, 'ODS Construction')
    await expect(h.workflow.approveAndSend(ready, { userId: 'owner-1', explicitlyApproved: false })).rejects.toThrow('Explicit owner approval')
    expect(h.sends).toHaveLength(0)
    const sent = await h.workflow.approveAndSend(ready, { userId: 'owner-1', explicitlyApproved: true })
    expect(sent.status).toBe('SENT')
    expect(h.sends).toHaveLength(1)
    expect(h.relations).toHaveLength(1)
    expect(h.events).toContain('freight.document.approved')
    expect(h.events).toContain('freight.document.sent')
  })

  it('is idempotent for discovery, generation and sent retries', async () => {
    const h = harness(); const input = { workspaceId: 'workspace-ods-fixture', conversationId: 'conv-1', requestMessageId: 'msg-request-1', request: KING_OCEAN_FIXTURE.request, evidence: [KING_OCEAN_FIXTURE.evidence] }
    const a = (await h.workflow.discover(input))!; const b = (await h.workflow.discover(input))!
    expect(a.id).toBe(b.id); expect(h.events.filter(e => e === 'freight.request.detected')).toHaveLength(1)
    const ready = await h.workflow.generate(a, KING_OCEAN_FIXTURE.evidence, 'ODS Construction')
    await h.workflow.generate(ready, KING_OCEAN_FIXTURE.evidence, 'ODS Construction')
    expect(h.writes).toHaveLength(1)
    const sent = await h.workflow.approveAndSend(ready, { userId: 'owner', explicitlyApproved: true })
    await h.workflow.approveAndSend(sent, { userId: 'owner', explicitlyApproved: true })
    expect(h.sends).toHaveLength(1)
  })

  it('rejects wrong-workspace evidence', async () => {
    const h = harness()
    const found = (await h.workflow.discover({ workspaceId: 'workspace-ods-fixture', conversationId: 'conv', requestMessageId: 'msg', request: KING_OCEAN_FIXTURE.request, evidence: [KING_OCEAN_FIXTURE.evidence] }))!
    await expect(h.workflow.generate(found, { ...KING_OCEAN_FIXTURE.evidence, workspaceId: 'other-workspace' }, 'ODS')).rejects.toThrow('different workspace')
  })

  it('does not alter ordinary non-freight inbox behavior', async () => {
    const h = harness()
    const result = await h.workflow.discover({ workspaceId: 'w', conversationId: 'c', requestMessageId: 'm', request: { ...KING_OCEAN_FIXTURE.request, isFreightDocumentRequest: false }, evidence: [] })
    expect(result).toBeNull(); expect(h.events).toHaveLength(0); expect(h.writes).toHaveLength(0); expect(h.sends).toHaveLength(0)
  })

  it('derives the generated PDF filename from the reference value for a TWINex warehouse-number request', async () => {
    const h = harness()
    const discovered = await h.workflow.discover({ workspaceId: 'workspace-ods-fixture', conversationId: 'conv-1', requestMessageId: 'msg-request-1', request: TWINEX_FIXTURE.request, evidence: [TWINEX_FIXTURE.evidence] })
    await h.workflow.generate(discovered!, TWINEX_FIXTURE.evidence, 'ODS Construction')
    expect(h.writes).toHaveLength(1)
    const filename = (h.writes[0] as { filename: string }).filename
    expect(filename).toBe('freight-188052.pdf')
    expect(filename).not.toContain('null')
    expect(filename).not.toMatch(/dock/i)
  })

  it('renders the King Ocean generated filename exactly as before -- regression', async () => {
    const h = harness()
    const discovered = await h.workflow.discover({ workspaceId: 'workspace-ods-fixture', conversationId: 'conv-1', requestMessageId: 'msg-request-1', request: KING_OCEAN_FIXTURE.request, evidence: [KING_OCEAN_FIXTURE.evidence] })
    await h.workflow.generate(discovered!, KING_OCEAN_FIXTURE.evidence, 'ODS Construction')
    expect(h.writes).toHaveLength(1)
    const filename = (h.writes[0] as { filename: string }).filename
    expect(filename).toBe('freight-DR-12345.pdf')
  })
})
