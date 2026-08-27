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

  it('a malformed/path-traversal-shaped id resolves to nothing — it is passed straight to the workspace-scoped lookup, never interpreted as a path', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getArtifactDetailMock.mockResolvedValue(null)
    const params2 = Promise.resolve({ id: '../../../etc/passwd' })
    const res = await GET(req('ws-1'), { params: params2 })
    expect(getArtifactDetailMock).toHaveBeenCalledWith('ws-1', '../../../etc/passwd')
    expect(res.status).toBe(404)
    expect(signArtifactUrlMock).not.toHaveBeenCalled()
  })

  it('ignores any client-supplied storage-path-shaped query param — the route accepts no such field at all', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getArtifactDetailMock.mockResolvedValue({
      artifact: { id: 'artifact-1', filename: 'max.png', modality: 'image', storage_path: 'ws-1/artifact-1/original.png' },
      observations: [], relations: [],
    })
    signArtifactUrlMock.mockResolvedValue('https://signed.example/artifact-1?token=abc')
    const reqWithForgedPath = new NextRequest(
      'http://localhost/api/founder/business-artifacts/artifact-1?workspaceId=ws-1&storage_path=ws-attacker/other-artifact/original.png&path=ws-attacker/other-artifact/original.png',
      { headers: { Authorization: 'Bearer test-token' } }
    )
    await GET(reqWithForgedPath, { params })
    // The ONLY path ever handed to signArtifactUrl is the one from the
    // authorized artifact row itself — never anything read off the request.
    expect(signArtifactUrlMock).toHaveBeenCalledWith('ws-1/artifact-1/original.png')
    expect(signArtifactUrlMock).not.toHaveBeenCalledWith('ws-attacker/other-artifact/original.png')
  })

  it('an artifact whose storage_state is not \'stored\' never reaches this route as resolvable — getArtifactDetail already refuses it, so no signed URL is minted', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    // Mirrors query.ts's own contract: getArtifactDetail returns null for
    // any storage_state other than 'stored' (see lib/artifacts/query.test.ts
    // for that guarantee at the source). This route has no independent
    // storage_state check of its own — it relies entirely on that contract,
    // which is exactly why getArtifactDetailMock returning null here is the
    // correct simulation of "pending/failed upload," not a gap in this test.
    getArtifactDetailMock.mockResolvedValue(null)
    const res = await GET(req('ws-1'), { params })
    expect(res.status).toBe(404)
    expect(signArtifactUrlMock).not.toHaveBeenCalled()
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
