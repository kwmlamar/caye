import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const resolveFounderOperatorMock = vi.fn()
vi.mock('@/lib/operator-identity', () => ({ resolveFounderOperator: (...args: unknown[]) => resolveFounderOperatorMock(...args) }))

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

const ingestArtifactMock = vi.fn()
vi.mock('@/lib/artifacts/ingest', () => ({ ingestArtifact: (...args: unknown[]) => ingestArtifactMock(...args) }))

import { POST } from './route'

function reqWithForm(fields: Record<string, string | Blob>): NextRequest {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return new NextRequest('http://localhost/api/founder/caye-direct/attachments', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
    body: form,
  })
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('POST /api/founder/caye-direct/attachments — enters the SAME business_artifacts pipeline as WhatsApp', () => {
  beforeEach(() => {
    requireFounderMock.mockReset()
    resolveFounderOperatorMock.mockReset().mockResolvedValue({ id: 7, name: 'Lamar' })
    ingestArtifactMock.mockReset()
  })

  it('rejects a non-founder caller with 403 before ever touching ingestArtifact', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    expect(res.status).toBe(403)
    expect(ingestArtifactMock).not.toHaveBeenCalled()
  })

  it('requires workspaceId, a valid idempotencyKey, and a file', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(reqWithForm({ idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    expect(res.status).toBe(400)
    expect(ingestArtifactMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported mime type without ever calling ingestArtifact', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File(['x'], 'a.exe', { type: 'application/x-msdownload' }) }))
    expect(res.status).toBe(400)
    expect(ingestArtifactMock).not.toHaveBeenCalled()
  })

  it('calls ingestArtifact with sourceChannel dashboard and the client idempotency key as provider_attachment_id', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    ingestArtifactMock.mockResolvedValue({
      ok: true,
      deduped: false,
      artifact: { id: 'artifact-1', filename: 'a.png', modality: 'image', detected_mime_type: 'image/png' },
    })
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    expect(res.status).toBe(200)
    expect(ingestArtifactMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      sourceChannel: 'dashboard',
      providerAttachmentId: 'key-1',
      origin: 'operator_uploaded',
      senderOperatorAllowlistId: 7,
    }))
    const json = await res.json()
    expect(json.artifactId).toBe('artifact-1')
  })

  it('a retried upload with the SAME idempotencyKey resolves through ingestArtifact dedup — no second row (#16)', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    ingestArtifactMock.mockResolvedValue({ ok: true, deduped: true, artifact: { id: 'artifact-1', filename: 'a.png', modality: 'image', detected_mime_type: 'image/png' } })
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    const json = await res.json()
    expect(json.deduped).toBe(true)
    expect(json.artifactId).toBe('artifact-1')
  })

  it('surfaces an upload failure as a real error — never a silent 200 (upload-failed failure semantics)', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    ingestArtifactMock.mockResolvedValue({ ok: false, error: 'upload failed: network error', errorCode: 'UPLOAD_FAILED' })
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const json = await res.json()
    expect(json.error).toMatch(/upload failed/i)
  })

  it('a file over the modality size limit is rejected with 413, not silently truncated or accepted', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    ingestArtifactMock.mockResolvedValue({ ok: false, error: 'File is 8MB, over the 5MB limit for image.', errorCode: 'TOO_LARGE' })
    const res = await POST(reqWithForm({ workspaceId: 'ws-1', idempotencyKey: 'key-1', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }))
    expect(res.status).toBe(413)
  })
})
