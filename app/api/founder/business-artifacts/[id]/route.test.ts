import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const getArtifactDetailMock = vi.fn()
vi.mock('@/lib/artifacts/query', () => ({ getArtifactDetail: (...args: unknown[]) => getArtifactDetailMock(...args) }))

const signArtifactUrlMock = vi.fn()
vi.mock('@/lib/artifacts/storage', () => ({ signArtifactUrl: (...args: unknown[]) => signArtifactUrlMock(...args) }))

import { GET } from './route'

function req(workspaceId?: string): NextRequest {
  const url = workspaceId
    ? `http://localhost/api/founder/business-artifacts/artifact-1?workspaceId=${workspaceId}`
    : 'http://localhost/api/founder/business-artifacts/artifact-1'
  return new NextRequest(url, { headers: { Authorization: 'Bearer test-token' } })
}

const params = Promise.resolve({ id: 'artifact-1' })

describe('GET /api/founder/business-artifacts/[id] — trusted id resolution (multimodal Caye Direct follow-up)', () => {
  beforeEach(() => {
    requireFounderMock.mockReset()
    getArtifactDetailMock.mockReset()
    signArtifactUrlMock.mockReset()
  })

  it('rejects a non-founder caller with 403 before ever resolving the artifact', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await GET(req('ws-1'), { params })
    expect(res.status).toBe(403)
    expect(getArtifactDetailMock).not.toHaveBeenCalled()
  })

  it('requires workspaceId', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await GET(req(undefined), { params })
    expect(res.status).toBe(400)
  })

  it('re-resolves the artifact against the given workspaceId — cross-workspace/forged id returns 404, never a signed URL', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getArtifactDetailMock.mockResolvedValue(null)
    const res = await GET(req('ws-1'), { params })
    expect(getArtifactDetailMock).toHaveBeenCalledWith('ws-1', 'artifact-1')
    expect(res.status).toBe(404)
    expect(signArtifactUrlMock).not.toHaveBeenCalled()
  })

  it('mints a fresh signed URL per request and never returns the raw storage_path', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getArtifactDetailMock.mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        filename: 'max.png',
        modality: 'image',
        detected_mime_type: 'image/png',
        received_at: '2026-08-26T10:00:00Z',
        processing_status: 'completed',
        storage_path: 'ws-1/artifact-1/original.png',
      },
      observations: [],
      relations: [],
    })
    signArtifactUrlMock.mockResolvedValue('https://signed.example/artifact-1?token=abc')

    const res = await GET(req('ws-1'), { params })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.artifact.url).toBe('https://signed.example/artifact-1?token=abc')
    expect(JSON.stringify(json)).not.toMatch(/ws-1\/artifact-1\/original\.png/)
    expect(signArtifactUrlMock).toHaveBeenCalledWith('ws-1/artifact-1/original.png')
  })

  it('never claims success when the signed URL could not be minted (render-failure honesty)', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getArtifactDetailMock.mockResolvedValue({
      artifact: { id: 'artifact-1', filename: 'max.png', modality: 'image', storage_path: 'ws-1/artifact-1/original.png' },
      observations: [],
      relations: [],
    })
    signArtifactUrlMock.mockResolvedValue(null)
    const res = await GET(req('ws-1'), { params })
    expect(res.ok).toBe(false)
  })
})
