import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { detectFreightRequestState } from './server-operations'
import { KING_OCEAN_FIXTURE, TWINEX_FIXTURE } from './fixture'
import type { PurchaseEvidence } from './types'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('detectFreightRequestState — pure detect+rank core shared by analyzeFreightWorkflow and the attention sweep', () => {
  it('classifies a King Ocean dock-receipt request as MATCH_FOUND against its matching receipt', () => {
    const result = detectFreightRequestState({
      requestMessageId: 'msg-1',
      subject: 'Dock Receipt DR-12345',
      body: 'Please send the commercial invoice for dock receipt DR-12345.',
      from: 'Nicole <nicole@example.test>',
      receivedAt: '2026-08-31T14:00:00Z',
      purchaseEvidence: [KING_OCEAN_FIXTURE.evidence],
    })
    expect(result).not.toBeNull()
    expect(result?.requestMessageId).toBe('msg-1')
    expect(result?.status).toBe('MATCH_FOUND')
    expect(result?.selectedEvidenceId).toBe(KING_OCEAN_FIXTURE.evidence.id)
  })

  it('classifies a TWINex warehouse-number request the same way, on the same evidence pool', () => {
    const result = detectFreightRequestState({
      requestMessageId: 'msg-2',
      subject: 'Warehouse #188052 - commercial invoice needed',
      body: 'Please send the commercial invoice for warehouse #188052.',
      from: 'Keisha <keisha@twinex.example.test>',
      receivedAt: '2026-08-31T14:00:00Z',
      purchaseEvidence: [TWINEX_FIXTURE.evidence],
    })
    expect(result?.status).toBe('MATCH_FOUND')
    expect(result?.request.reference).toEqual({ kind: 'warehouse_number', value: '188052' })
  })

  it('reports NO_MATCH — not null — when nothing in the ingested evidence pool matches yet', () => {
    // This is the case the dashboard-only path silently dropped: a freight
    // request with zero purchase evidence relations written by the Gmail
    // cron produces no dashboard record at all, so there was nothing to read.
    // The sweep must still be able to tell Wallace "this forwarder asked and
    // nothing answers it yet" instead of staying silent.
    const result = detectFreightRequestState({
      requestMessageId: 'msg-3',
      subject: 'Dock Receipt DR-99999',
      body: 'Please send the commercial invoice for dock receipt DR-99999.',
      from: 'Nicole <nicole@example.test>',
      receivedAt: '2026-08-31T14:00:00Z',
      purchaseEvidence: [],
    })
    expect(result).not.toBeNull()
    expect(result?.status).toBe('NO_MATCH')
    expect(result?.selectedEvidenceId).toBeNull()
  })

  it('returns AMBIGUOUS with no selection when two candidates score equally', () => {
    const second: PurchaseEvidence = { ...KING_OCEAN_FIXTURE.evidence, id: 'receipt-b' }
    const result = detectFreightRequestState({
      requestMessageId: 'msg-4',
      subject: 'Dock Receipt DR-12345',
      body: 'Please send the commercial invoice for dock receipt DR-12345.',
      from: 'Nicole <nicole@example.test>',
      receivedAt: '2026-08-31T14:00:00Z',
      purchaseEvidence: [KING_OCEAN_FIXTURE.evidence, second],
    })
    expect(result?.status).toBe('AMBIGUOUS')
    expect(result?.selectedEvidenceId).toBeNull()
  })

  it('returns null for an ordinary email that is not a freight document request', () => {
    const result = detectFreightRequestState({
      requestMessageId: 'msg-5',
      subject: 'Monthly invoice',
      body: 'Your invoice is attached.',
      from: 'billing@vendor.test',
      receivedAt: '2026-08-31T14:00:00Z',
      purchaseEvidence: [KING_OCEAN_FIXTURE.evidence],
    })
    expect(result).toBeNull()
  })
})

describe('freight-attention wiring — classification without side effects', () => {
  it('reads detection from server-operations and never writes metadata, workspace_events, or human_agent_enabled itself', () => {
    const attention = source('lib/freight-attention.ts')
    expect(attention).toContain("from '@/lib/freight/server-operations'")
    expect(attention).toContain('detectOpenFreightRequest')
    expect(attention).toContain('loadPurchaseEvidence')
    // These are analyzeFreightWorkflow's side effects alone -- the sweep must
    // only ever read (including its existing read of unified_conversations),
    // never write metadata, insert a workspace_event, or flip
    // human_agent_enabled itself.
    expect(attention).not.toContain('freight_workflow:')
    expect(attention).not.toMatch(/unified_conversations['"]\)\s*\n?\s*\.update\(/)
    expect(attention).not.toContain(".from('workspace_events')")
    expect(attention).not.toMatch(/human_agent_enabled\s*:/)
  })

  it('still calls the underlying detect+rank core, not a second parallel implementation', () => {
    const shared = source('lib/freight/server-operations.ts')
    // detectFreightRequestState/detectOpenFreightRequest must remain the only
    // place that calls detectFreightRequest + rankPurchaseEvidence together --
    // analyzeFreightWorkflow and the attention sweep both go through it.
    expect(shared.match(/detectFreightRequest\(/g)?.length).toBe(1)
    expect(shared.match(/rankPurchaseEvidence\(/g)?.length).toBe(1)
    expect(shared).toContain('export function detectFreightRequestState')
    expect(shared).toContain('export async function detectOpenFreightRequest')
  })
})
