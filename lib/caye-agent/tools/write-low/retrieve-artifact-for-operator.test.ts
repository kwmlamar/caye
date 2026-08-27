import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const getArtifactDetail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/artifacts/query', () => ({ getArtifactDetail }))

const signArtifactUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/artifacts/storage', () => ({ signArtifactUrl }))

const isWhatsAppWindowOpen = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen }))

const sendMediaWhatsApp = vi.hoisted(() => vi.fn())
vi.mock('@/lib/whatsapp/outbound', () => ({ sendMediaWhatsApp }))

const operatorLookupResult = vi.hoisted(() => ({ value: { data: { id: 42, phone: '+12345550100' } } }))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(operatorLookupResult.value),
        }),
      }),
    }),
  }),
}))

import { retrieveArtifactForOperator } from './retrieve-artifact-for-operator'
import type { ToolContext } from '../types'

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorId: 42,
    requestId: 'req-1',
    ...overrides,
  }
}

const STORED_IMAGE_DETAIL = {
  artifact: {
    id: 'artifact-1',
    workspace_id: 'ws-1',
    modality: 'image',
    retention_status: 'active',
    storage_state: 'stored',
    storage_path: 'ws-1/artifact-1/original.jpg',
    filename: 'pickup.jpg',
    source_channel: 'whatsapp_operator',
    received_at: '2026-08-26T10:00:00Z',
  },
  observations: [],
  relations: [],
}

beforeEach(() => {
  getArtifactDetail.mockReset().mockResolvedValue(STORED_IMAGE_DETAIL)
  signArtifactUrl.mockReset().mockResolvedValue('https://signed.example/artifact-1?token=abc')
  isWhatsAppWindowOpen.mockReset().mockResolvedValue(true)
  sendMediaWhatsApp.mockReset().mockResolvedValue({ status: 'sent', messageId: 'wamid.sent-1' })
  operatorLookupResult.value = { data: { id: 42, phone: '+12345550100' } }
})

describe('retrieve_artifact_for_operator — workspace/storage gating (#87 review pass 2, item F)', () => {
  it('re-checks workspace ownership via getArtifactDetail before ever touching storage or sending', async () => {
    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(getArtifactDetail).toHaveBeenCalledWith('ws-1', 'artifact-1')
  })

  it('refuses when the artifact is not found in this workspace (cross-workspace id) — never signs a URL', async () => {
    getArtifactDetail.mockResolvedValueOnce(null)
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-other-workspace' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(signArtifactUrl).not.toHaveBeenCalled()
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('refuses a tombstoned/deleted artifact even if somehow fetched', async () => {
    getArtifactDetail.mockResolvedValueOnce({ ...STORED_IMAGE_DETAIL, artifact: { ...STORED_IMAGE_DETAIL.artifact, retention_status: 'tombstoned' } })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('never sends media for an unsupported modality', async () => {
    getArtifactDetail.mockResolvedValueOnce({ ...STORED_IMAGE_DETAIL, artifact: { ...STORED_IMAGE_DETAIL.artifact, modality: 'spreadsheet' } })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('refuses to send when the 24h WhatsApp window is closed', async () => {
    isWhatsAppWindowOpen.mockResolvedValueOnce(false)
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('never sends when a signed URL could not be minted', async () => {
    signArtifactUrl.mockResolvedValueOnce(null)
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('only ever sends to the phone resolved for ctx.operatorId — never a caller-supplied number', async () => {
    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    // The tool's inputSchema has no phone/recipient field at all — this
    // asserts the actual call target, proving there is no path from tool
    // arguments to an arbitrary recipient.
    expect(sendMediaWhatsApp).toHaveBeenCalledWith('+12345550100', 'image', expect.any(String), expect.anything(), expect.any(String))
  })
})

describe('retrieve_artifact_for_operator — failure honesty (#87 review pass 2, item F)', () => {
  it('a definite provider rejection is reported as a real failure, never narrated as success', async () => {
    sendMediaWhatsApp.mockResolvedValueOnce({ status: 'failed', error: 'meta http 400 code 131051', transient: false })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
  })

  it('an ambiguous/transient network outcome is reported as UNCERTAIN, not a confident failure, and is not marked retryable', async () => {
    sendMediaWhatsApp.mockResolvedValueOnce({ status: 'failed', error: 'network: socket hang up', transient: true })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())

    expect(result.ok).toBe(false)
    expect(result.status).toBe('FAILED_PERMANENT') // never FAILED_RETRYABLE — a system retry here risks a real duplicate send
    expect(result.error).toMatch(/couldn't confirm whether that actually sent/i)
  })

  it('a blocked recipient is reported as needing a human, not silently retried', async () => {
    sendMediaWhatsApp.mockResolvedValueOnce({ status: 'failed', error: 'meta http 400 code 131026', transient: false, blocked: true })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NEEDS_HUMAN')
  })

  it('success carries the provider message id as durable evidence of what was actually sent', async () => {
    sendMediaWhatsApp.mockResolvedValueOnce({ status: 'sent', messageId: 'wamid.abc123' })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect(result.ok).toBe(true)
    expect((result.data as { provider_message_id?: string })?.provider_message_id).toBe('wamid.abc123')
  })
})

describe('retrieve_artifact_for_operator — channel-aware delivery (multimodal Caye Direct follow-up)', () => {
  it('a WhatsApp turn (no ctx.engineeringOrigin) sends real WhatsApp media, unchanged', async () => {
    const ctx = baseCtx()
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)
    expect(sendMediaWhatsApp).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect((result.data as { delivery?: string }).delivery).toBe('whatsapp')
    expect(ctx.businessArtifactIds).toBeUndefined()
  })

  it('a Caye Direct turn (ctx.engineeringOrigin set) never sends WhatsApp media or looks up a phone/window', async () => {
    const ctx = baseCtx({ engineeringOrigin: { threadId: 'thread-1', messageId: 'msg-1' } })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)

    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
    expect(isWhatsAppWindowOpen).not.toHaveBeenCalled()
    expect(signArtifactUrl).not.toHaveBeenCalled() // minted later, per-request, by the resolve route — never here
    expect(result.ok).toBe(true)
    expect((result.data as { delivery?: string }).delivery).toBe('inline')
  })

  it('pushes the artifact id onto ctx.businessArtifactIds for inline delivery — the accumulator founder-thread-turn.ts reads back', async () => {
    const ctx = baseCtx({ engineeringOrigin: { threadId: 'thread-1', messageId: 'msg-1' } })
    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)
    expect(ctx.businessArtifactIds).toEqual(['artifact-1'])
  })

  it('a repeated call within the same turn does not send WhatsApp media a second time when inline', async () => {
    const ctx = baseCtx({ engineeringOrigin: { threadId: 'thread-1', messageId: 'msg-1' }, businessArtifactIds: [] })
    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)
    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)
    expect(ctx.businessArtifactIds).toEqual(['artifact-1', 'artifact-1']) // dedup happens one layer up (cayeAgent's Set) — see index.ts
    expect(sendMediaWhatsApp).not.toHaveBeenCalled()
  })

  it('still refuses a tombstoned artifact on the Direct path — the retention check runs before the channel branch', async () => {
    getArtifactDetail.mockResolvedValueOnce({ ...STORED_IMAGE_DETAIL, artifact: { ...STORED_IMAGE_DETAIL.artifact, retention_status: 'tombstoned' } })
    const ctx = baseCtx({ engineeringOrigin: { threadId: 'thread-1', messageId: 'msg-1' } })
    const result = await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)
    expect(result.ok).toBe(false)
    expect(ctx.businessArtifactIds).toBeUndefined()
  })
})

describe('retrieve_artifact_for_operator — composes with active work without disturbing it (#87 review pass 2, item E)', () => {
  it('never reads or mutates ctx.activeWork — sending an artifact mid-draft leaves the active draft untouched', async () => {
    const activeWork = { sourceMessageId: 'msg-jeff-proposal', entityRef: 'jeff@example.com', operation: 'customer_reply_draft' as const }
    const ctx = baseCtx({ activeWork })

    await retrieveArtifactForOperator.execute({ artifact_id: 'artifact-1' }, ctx)

    expect(ctx.activeWork).toBe(activeWork)
    expect(ctx.activeWork?.entityRef).toBe('jeff@example.com')
  })
})
