import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const runFounderThreadTurnMock = vi.fn()
vi.mock('@/lib/caye-agent/founder-thread-turn', () => ({
  runFounderThreadTurn: (...args: unknown[]) => runFounderThreadTurnMock(...args),
}))

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: vi.fn(),
  getThreadEntities: vi.fn(),
  getThreadMessages: vi.fn(),
  describeEntity: vi.fn(),
  renameThread: vi.fn(),
  setThreadStatus: vi.fn(),
  setThreadPinned: vi.fn(),
  deleteThread: vi.fn(),
}))
vi.mock('@/lib/caye-direct-rich-result-resolution', () => ({ resolveRichResultReferences: vi.fn() }))

import { POST, PATCH, DELETE } from './route'
import { setThreadPinned, deleteThread } from '@/lib/caye-direct-threads'

const setThreadPinnedMock = vi.mocked(setThreadPinned)
const deleteThreadMock = vi.mocked(deleteThread)

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/threads/thread-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/threads/thread-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

function deleteReq(workspaceId: string | null): NextRequest {
  const url = workspaceId
    ? `http://localhost/api/founder/caye-direct/threads/thread-1?workspaceId=${workspaceId}`
    : 'http://localhost/api/founder/caye-direct/threads/thread-1'
  return new NextRequest(url, { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } })
}

const params = Promise.resolve({ id: 'thread-1' })

describe('POST /api/founder/caye-direct/threads/[id] — attachments (multimodal Caye Direct follow-up)', () => {
  beforeEach(() => {
    requireFounderMock.mockReset().mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockReset().mockResolvedValue({ replyText: 'Here it is.', threadId: 'thread-1' })
  })

  it('rejects a request with neither a message nor an attachment', async () => {
    const res = await POST(req({ workspaceId: 'ws-1' }), { params })
    expect(res.status).toBe(400)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('accepts an attachment-only send with no text', async () => {
    const res = await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['artifact-1'] }), { params })
    expect(res.status).toBe(200)
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', '', undefined, ['artifact-1'])
  })

  it('forwards a plain text message with no attachments unchanged', async () => {
    await POST(req({ workspaceId: 'ws-1', message: 'hello' }), { params })
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', 'hello', undefined, undefined)
  })

  it('filters out non-string entries from attachmentArtifactIds rather than forwarding them', async () => {
    await POST(req({ workspaceId: 'ws-1', message: 'x', attachmentArtifactIds: ['artifact-1', 42, null, ''] }), { params })
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', 'x', undefined, ['artifact-1'])
  })

  it('maps "Invalid attachment" to 400, distinct from a generic 500', async () => {
    runFounderThreadTurnMock.mockRejectedValue(new Error('Invalid attachment'))
    const res = await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['forged-id'] }), { params })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid attachment')
  })

  it('maps "Too many attachments" to 400', async () => {
    runFounderThreadTurnMock.mockRejectedValue(new Error('Too many attachments'))
    const res = await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), { params })
    expect(res.status).toBe(400)
  })

  it('maps "Attachment unreadable" to 502 with a retry-friendly message, distinct from a client-input 400', async () => {
    runFounderThreadTurnMock.mockRejectedValue(new Error('Attachment unreadable'))
    const res = await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['artifact-1'] }), { params })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toMatch(/try again/i)
  })

  it('still maps "Thread not found" to 404 alongside the new attachment handling', async () => {
    runFounderThreadTurnMock.mockRejectedValue(new Error('Thread not found'))
    const res = await POST(req({ workspaceId: 'ws-1', message: 'hi' }), { params })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/founder/caye-direct/threads/[id] — pin/unpin (sidebar "more" menu)', () => {
  beforeEach(() => {
    requireFounderMock.mockReset().mockResolvedValue({ id: 'founder-1' })
    setThreadPinnedMock.mockReset().mockResolvedValue(true)
  })

  it('pins a thread', async () => {
    const res = await PATCH(patchReq({ workspaceId: 'ws-1', pinned: true }), { params })
    expect(res.status).toBe(200)
    expect(setThreadPinnedMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1', true)
  })

  it('unpins a thread', async () => {
    await PATCH(patchReq({ workspaceId: 'ws-1', pinned: false }), { params })
    expect(setThreadPinnedMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1', false)
  })

  it('404s when the thread does not belong to the workspace', async () => {
    setThreadPinnedMock.mockResolvedValue(false)
    const res = await PATCH(patchReq({ workspaceId: 'ws-1', pinned: true }), { params })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/founder/caye-direct/threads/[id] — sidebar "more" menu, distinct from Archive', () => {
  beforeEach(() => {
    requireFounderMock.mockReset().mockResolvedValue({ id: 'founder-1' })
    deleteThreadMock.mockReset().mockResolvedValue(true)
  })

  it('requires workspaceId', async () => {
    const res = await DELETE(deleteReq(null), { params })
    expect(res.status).toBe(400)
    expect(deleteThreadMock).not.toHaveBeenCalled()
  })

  it('deletes the thread', async () => {
    const res = await DELETE(deleteReq('ws-1'), { params })
    expect(res.status).toBe(200)
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1')
  })

  it('404s when the thread does not belong to the workspace', async () => {
    deleteThreadMock.mockResolvedValue(false)
    const res = await DELETE(deleteReq('ws-1'), { params })
    expect(res.status).toBe(404)
  })
})
