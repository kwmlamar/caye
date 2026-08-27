import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Literal regression fixture for the production scenario that motivated
 * the multimodal Caye Direct follow-up to #87:
 *
 *   WhatsApp (back office):
 *     [Lamar sends a photo]
 *     "the guy on the left is max, this is a recent photo of him and some
 *      guests after a tour"
 *   → Caye persists the image and a confirmed relation to Max.
 *
 *   Later, a NEW Caye Direct conversation:
 *     "send me that image of max we talked about earlier"
 *   → Caye correctly retrieves the artifact and responds "Sent — Max on the
 *     left with two guests post-tour."
 *
 * What actually broke: Caye Direct never rendered the image — only the
 * WhatsApp-shaped text claim did. This fixture pins two things end to end
 * using the REAL retrieval/delivery code (lib/artifacts/query.ts's
 * searchArtifacts + retrieve_artifact_for_operator's execute()), not a
 * paraphrase of them:
 *
 *   1. An artifact ingested over WhatsApp is findable by a Direct-channel
 *      free-text query with no WhatsApp-specific context required — cross-
 *      channel durable memory (item D).
 *   2. Retrieving it on the Direct channel (ctx.engineeringOrigin set)
 *      never sends WhatsApp media and never claims "Sent" — it resolves to
 *      an inline business_artifact reference instead (the actual fix).
 */

const MAX_ARTIFACT_ID = 'artifact-max-photo'
const MAX_RELATION_LABEL = 'Max on the left with two guests post-tour'

const maxArtifactRow = {
  id: MAX_ARTIFACT_ID,
  workspace_id: 'ws-bimini',
  origin: 'external',
  source_channel: 'whatsapp_operator',
  modality: 'image',
  filename: null,
  storage_path: 'ws-bimini/artifact-max-photo/original.jpg',
  storage_state: 'stored',
  retention_status: 'active',
  received_at: '2026-08-20T14:00:00Z',
  sender_operator_allowlist_id: 7,
}

const maxObservation = {
  id: 'obs-max-1',
  artifact_id: MAX_ARTIFACT_ID,
  observation_type: 'visual_description',
  content: { description: 'Two people standing outdoors after a tour; one man on the left, two guests beside him.' },
  superseded_at: null,
}

const maxConfirmedRelation = {
  id: 'rel-max-1',
  artifact_id: MAX_ARTIFACT_ID,
  relation_type: 'depicts_person',
  target_entity_type: 'contact',
  target_entity_id: 'contact-max',
  label: MAX_RELATION_LABEL,
  status: 'confirmed',
  provenance: 'operator_confirmed',
  superseded_at: null,
}

/** Applies one filter predicate; `in:` and `!=` filters are real exclusion/inclusion checks, not skipped. */
function applyFilter<T extends Record<string, unknown>>(rows: T[], [col, val]: [string, unknown]): T[] {
  const s = String(val)
  if (s.startsWith('!=')) return rows.filter((r) => r[col] !== s.slice(2))
  if (s.startsWith('in:')) {
    const set = new Set(s.slice(3).split(','))
    return rows.filter((r) => set.has(String(r[col])))
  }
  return rows.filter((r) => r[col] === val)
}

const operatorRow = { id: 7, phone: '+12425550100' }

function fakeSupabase() {
  function tableChain(table: string) {
    const rows: Record<string, unknown>[] =
      table === 'business_artifacts' ? [maxArtifactRow]
      : table === 'business_artifact_observations' ? [maxObservation]
      : table === 'business_artifact_relations' ? [maxConfirmedRelation]
      : table === 'operator_allowlist' ? [operatorRow]
      : []
    const filters: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((col: string, val: unknown) => { filters.push([col, val]); return chain })
    chain.neq = vi.fn((col: string, val: unknown) => { filters.push([col, `!=${val}`]); return chain })
    chain.is = vi.fn(() => chain) // superseded_at null-check — every fixture row already satisfies it, so a no-op here is faithful enough.
    chain.in = vi.fn((col: string, vals: unknown[]) => { filters.push([col, `in:${vals.join(',')}`]); return chain })
    chain.gte = vi.fn(() => chain)
    chain.lte = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.select = vi.fn(() => chain)
    // Thenable: real supabase-js query builders resolve when awaited
    // directly, with or without a trailing .limit()/.maybeSingle() —
    // query.ts relies on both shapes (searchArtifacts calls .limit(200),
    // the observations/relations Promise.all in the same function awaits
    // the builder with no terminal call at all).
    chain.then = (onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) => {
      const result = { data: filters.reduce((acc, f) => applyFilter(acc, f), rows), error: null }
      return Promise.resolve(result).then(onfulfilled, onrejected)
    }
    chain.maybeSingle = vi.fn(() => {
      const matched = filters.reduce((acc, f) => applyFilter(acc, f), rows)
      return Promise.resolve({ data: matched[0] ?? null, error: null })
    })
    return chain
  }
  return { from: vi.fn((table: string) => ({ select: vi.fn(() => tableChain(table)) })) }
}

const supabaseStub = fakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => supabaseStub }))

const isWhatsAppWindowOpen = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen }))
const sendMediaWhatsApp = vi.hoisted(() => vi.fn())
vi.mock('@/lib/whatsapp/outbound', () => ({ sendMediaWhatsApp }))
const signArtifactUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://signed.example/max.jpg'))
vi.mock('@/lib/artifacts/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, signArtifactUrl }
})

import { searchArtifacts } from './query'
import { retrieveArtifactForOperator } from '../caye-agent/tools/write-low/retrieve-artifact-for-operator'
import type { ToolContext } from '../caye-agent/tools/types'

describe('regression: the Max photo — cross-channel durable memory + inline Direct rendering', () => {
  it('a Direct-channel free-text query finds the WhatsApp-ingested artifact with no WhatsApp-specific context', async () => {
    const { items, ambiguous } = await searchArtifacts({ workspaceId: 'ws-bimini', query: 'image of max' })
    expect(ambiguous).toBe(false)
    expect(items).toHaveLength(1)
    expect(items[0].artifact.id).toBe(MAX_ARTIFACT_ID)
    expect(items[0].artifact.source_channel).toBe('whatsapp_operator') // ingested over WhatsApp
    expect(items[0].confirmedRelations[0]?.label).toBe(MAX_RELATION_LABEL)
  })

  it('retrieving it on Caye Direct (ctx.engineeringOrigin set) renders it inline — never sends WhatsApp media, never claims "Sent"', async () => {
    const ctx: ToolContext = {
      workspaceId: 'ws-bimini',
      callerRole: 'founder',
      operatorId: 7,
      requestId: 'req-direct-1',
      engineeringOrigin: { threadId: 'thread-new-direct-convo', messageId: 'msg-1' },
    }
    const result = await retrieveArtifactForOperator.execute({ artifact_id: MAX_ARTIFACT_ID }, ctx)

    expect(result.ok).toBe(true)
    expect((result.data as { delivery?: string }).delivery).toBe('inline')
    expect((result.data as Record<string, unknown>).sent).toBeUndefined() // never a false "Sent" claim on this channel
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
    expect(ctx.businessArtifactIds).toEqual([MAX_ARTIFACT_ID])
  })

  it('retrieving the SAME artifact on the original WhatsApp channel is unaffected — still a real send', async () => {
    sendMediaWhatsApp.mockResolvedValueOnce({ status: 'sent', messageId: 'wamid.max-1' })
    const ctx: ToolContext = { workspaceId: 'ws-bimini', callerRole: 'owner', operatorId: 7, requestId: 'req-wa-1' }
    const result = await retrieveArtifactForOperator.execute({ artifact_id: MAX_ARTIFACT_ID }, ctx)

    expect(result.ok).toBe(true)
    expect((result.data as { delivery?: string }).delivery).toBe('whatsapp')
    expect((result.data as { sent?: boolean }).sent).toBe(true)
    expect(sendMediaWhatsApp).toHaveBeenCalledTimes(1)
  })
})
