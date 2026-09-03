import { describe, expect, it } from 'vitest'

import {
  FREIGHT_ATTENTION_RULES,
  SUBJECT_FREIGHT_REQUEST,
  fingerprintPartsFor,
  nextActionFor,
  projectFreightRequestsToAttention,
  referenceLabelFor,
  ruleFor,
  titleFor,
  type FreightAttentionConversation,
} from './freight-attention'
import type { FreightReference, FreightRequest } from './freight/types'
import type { FreightWorkflowRecord } from './freight/workflow'

const WORKSPACE = '11111111-1111-1111-1111-111111111111'

function reference(overrides: Partial<FreightReference> = {}): FreightReference {
  return { kind: 'dock_receipt', value: '10432233', ...overrides }
}

function request(overrides: Partial<FreightRequest> = {}): FreightRequest {
  return {
    isFreightDocumentRequest: true,
    evidence: ['dock_receipt:10432233', 'freight_language', 'request_language'],
    freightProvider: 'King Ocean',
    senderName: 'King Ocean Dispatch',
    senderEmail: 'dispatch@kingocean.com',
    reference: reference(),
    dockReceiptNumber: '10432233',
    shipmentReference: null,
    requestedDocument: 'commercial invoice',
    consolidationMentioned: false,
    destination: null,
    commodities: [],
    requestedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  }
}

function workflow(overrides: Partial<FreightWorkflowRecord> = {}): FreightWorkflowRecord {
  return {
    id: 'freight:msg-1',
    workspaceId: WORKSPACE,
    conversationId: 'conv-1',
    requestMessageId: 'msg-1',
    request: request(),
    status: 'READY_FOR_APPROVAL',
    candidates: [],
    selectedEvidenceId: 'ev-1',
    generatedArtifactId: 'artifact-1',
    reply: 'Please find the attached commercial invoice.',
    approvedAt: null,
    sentAt: null,
    ...overrides,
  }
}

/** Records what the ledger was asked to observe, without touching Supabase. */
function recorder() {
  const calls: Array<Record<string, unknown>> = []
  const observe = (async (args: Record<string, unknown>) => {
    calls.push(args)
    return null
  }) as never
  return { calls, observe }
}

function run(conversations: FreightAttentionConversation[], observe: never) {
  return projectFreightRequestsToAttention({
    workspaceId: WORKSPACE,
    deps: { loadOpenRequests: async () => conversations, observe },
  })
}

describe('projectFreightRequestsToAttention', () => {
  it('raises attention for a request still awaiting a human', async () => {
    const { calls, observe } = recorder()
    const result = await run([{ conversationId: 'conv-1', workflow: workflow({ status: 'READY_FOR_APPROVAL' }) }], observe)

    expect(result).toEqual({
      considered: 1,
      raised: 1,
      skipped: { alreadySent: 0, malformed: 0, unknownStatus: 0 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].subjectType).toBe(SUBJECT_FREIGHT_REQUEST)
    expect(calls[0].subjectId).toBe('conv-1')
    expect(calls[0].conversationId).toBe('conv-1')
    expect(calls[0].workspaceId).toBe(WORKSPACE)
  })

  it('does not raise attention for a request already sent', async () => {
    // The loader itself excludes SENT rows, but the sweep must not trust a
    // stale/cached read as the last word either.
    const { calls, observe } = recorder()
    const result = await run([{ conversationId: 'conv-1', workflow: workflow({ status: 'SENT', sentAt: '2026-08-01T00:00:00.000Z' }) }], observe)

    expect(result).toEqual({
      considered: 1,
      raised: 0,
      skipped: { alreadySent: 1, malformed: 0, unknownStatus: 0 },
    })
    expect(calls).toHaveLength(0)
  })

  it('names a TWINex warehouse-number request correctly and never says Dock or UNKNOWN', async () => {
    const twinex = workflow({
      status: 'READY_FOR_APPROVAL',
      request: request({
        freightProvider: 'TWINex',
        senderName: 'TWINex Logistics',
        reference: { kind: 'warehouse_number', value: '188052' },
        dockReceiptNumber: null,
      }),
    })
    const { calls, observe } = recorder()
    await run([{ conversationId: 'conv-twinex', workflow: twinex }], observe)

    const title = String(calls[0].title)
    const nextAction = String(calls[0].nextAction)
    expect(title).toContain('Warehouse 188052')
    expect(title).not.toContain('Dock')
    expect(title).not.toContain('UNKNOWN')
    expect(nextAction).toContain('Warehouse 188052')
    expect(nextAction).not.toContain('Dock')
    expect(nextAction).not.toContain('UNKNOWN')
  })

  it('names a King Ocean dock-receipt request correctly, beside the TWINex case above', async () => {
    const kingOcean = workflow({ status: 'READY_FOR_APPROVAL', request: request({ reference: reference({ value: '10432233' }) }) })
    const { calls, observe } = recorder()
    await run([{ conversationId: 'conv-king-ocean', workflow: kingOcean }], observe)

    const title = String(calls[0].title)
    expect(title).toContain('Dock Receipt 10432233')
    expect(title).not.toContain('Warehouse')
    expect(title).not.toContain('UNKNOWN')
  })

  it('fingerprints on status and whether a document was generated, not on age', () => {
    const fresh = workflow({ status: 'NO_MATCH', generatedArtifactId: null, request: request({ requestedAt: '2026-07-01T00:00:00.000Z' }) })
    const stale = workflow({ status: 'NO_MATCH', generatedArtifactId: null, request: request({ requestedAt: '2026-05-01T00:00:00.000Z' }) })

    // Same status, same generated-document state, wildly different request
    // age -- must fingerprint identically, or every open request re-earns
    // attention on every five-minute sweep.
    expect(fingerprintPartsFor(fresh)).toEqual(fingerprintPartsFor(stale))
  })

  it('changes the fingerprint when the status or generated-document state actually moves', () => {
    const matched = workflow({ status: 'MATCH_FOUND', generatedArtifactId: null })
    const ready = workflow({ status: 'READY_FOR_APPROVAL', generatedArtifactId: 'artifact-1' })

    expect(fingerprintPartsFor(matched)).not.toEqual(fingerprintPartsFor(ready))
  })

  it('gives ready-to-send, ambiguous, and no-match three different priorities', () => {
    const ready = ruleFor('READY_FOR_APPROVAL')?.priority
    const ambiguous = ruleFor('AMBIGUOUS')?.priority
    const noMatch = ruleFor('NO_MATCH')?.priority

    expect(ready).toBeDefined()
    expect(ambiguous).toBeDefined()
    expect(noMatch).toBeDefined()
    expect(new Set([ready, ambiguous, noMatch]).size).toBe(3)
  })

  it('never asserts the document was sent in any next action', () => {
    for (const status of Object.keys(FREIGHT_ATTENTION_RULES) as Array<keyof typeof FREIGHT_ATTENTION_RULES>) {
      const action = nextActionFor(workflow({ status: status as FreightWorkflowRecord['status'] }))
      expect(action).not.toBeNull()
      expect(action?.toLowerCase()).not.toContain('sent')
      expect(action?.toLowerCase()).not.toContain('has been')
    }
  })

  it('processes a mixed batch without letting one malformed record stop the rest', async () => {
    const { calls, observe } = recorder()
    const result = await run(
      [
        { conversationId: 'conv-ok', workflow: workflow({ status: 'READY_FOR_APPROVAL' }) },
        { conversationId: 'conv-bad', workflow: { } as unknown as FreightWorkflowRecord },
        { conversationId: 'conv-sent', workflow: workflow({ status: 'SENT' }) },
      ],
      observe
    )

    expect(result).toEqual({
      considered: 3,
      raised: 1,
      skipped: { alreadySent: 1, malformed: 1, unknownStatus: 0 },
    })
    expect(calls).toHaveLength(1)
  })

  it('marks every raised freight item as blocked on the operator and not autonomously resolvable', async () => {
    // Nothing progresses without Wallace: approving, sending, picking
    // between candidates, or supplying a missing document are all his to
    // do, and a send is a consequential action Caye cannot take alone.
    const { calls, observe } = recorder()
    await run([{ conversationId: 'conv-1', workflow: workflow({ status: 'AMBIGUOUS' }) }], observe)

    expect(calls[0].blockedOnOperator).toBe(true)
    expect(calls[0].resolvableAutonomously).toBe(false)
  })
})

describe('referenceLabelFor', () => {
  it('never surfaces the raw UNKNOWN label for a request with no extracted reference', () => {
    const label = referenceLabelFor(workflow({ request: request({ reference: null, dockReceiptNumber: null }) }))
    expect(label).not.toBe('UNKNOWN')
  })
})

describe('titleFor', () => {
  it('falls back gracefully for a status this table has no rule for', () => {
    const title = titleFor(workflow({ status: 'SENT' as FreightWorkflowRecord['status'] }))
    expect(title).toContain('Dock Receipt 10432233')
  })
})
