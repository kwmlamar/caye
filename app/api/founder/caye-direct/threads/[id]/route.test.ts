import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const runFounderThreadTurnMock = vi.fn()
vi.mock('@/lib/caye-agent/founder-thread-turn', () => ({
  runFounderThreadTurn: (...args: unknown[]) => runFounderThreadTurnMock(...args),
}))

const resolveAuthoritativeThreadWorkspaceMock = vi.fn()
vi.mock('@/lib/caye-direct-thread-scope', () => ({
  resolveAuthoritativeThreadWorkspace: (...args: unknown[]) => resolveAuthoritativeThreadWorkspaceMock(...args),
}))

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/caye-direct-threads', () => ({
  getFounderThreadById: vi.fn(),
  getThreadEntities: vi.fn(),
  getThreadMessages: vi.fn(),
  describeEntity: vi.fn(),
  renameThread: vi.fn(),
  setThreadStatus: vi.fn(),
  setThreadPinned: vi.fn(),
  setThreadActiveWorkspace: vi.fn(),
  deleteThread: vi.fn(),
}))
vi.mock('@/lib/caye-direct-rich-result-resolution', () => ({ resolveRichResultReferences: vi.fn() }))

import { POST, PATCH, DELETE } from './route'
import {
  getFounderThreadById,
  setThreadPinned,
  setThreadActiveWorkspace,
  deleteThread,
} from '@/lib/caye-direct-threads'

const getFounderThreadByIdMock = vi.mocked(getFounderThreadById)
const setThreadPinnedMock = vi.mocked(setThreadPinned)
const setThreadActiveWorkspaceMock = vi.mocked(setThreadActiveWorkspace)
const deleteThreadMock = vi.mocked(deleteThread)

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/threads/thread-1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(body),
  })
}
function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/threads/thread-1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(body),
  })
}
function deleteReq(): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/threads/thread-1', { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } })
}

const params = Promise.resolve({ id: 'thread-1' })
const thread = { id: 'thread-1', active_workspace_id: 'ws-1' }

describe('founder-scoped Caye Direct thread route', () => {
  beforeEach(() => {
    requireFounderMock.mockReset().mockResolvedValue({ id: 'founder-1' })
    getFounderThreadByIdMock.mockReset().mockResolvedValue(thread as never)
    resolveAuthoritativeThreadWorkspaceMock.mockReset().mockResolvedValue(null)
    setThreadActiveWorkspaceMock.mockReset().mockResolvedValue(true)
    setThreadPinnedMock.mockReset().mockResolvedValue(true)
    deleteThreadMock.mockReset().mockResolvedValue(true)
    runFounderThreadTurnMock.mockReset().mockResolvedValue({ replyText: 'Here it is.', threadId: 'thread-1' })
  })

  it('rejects a request with neither a message nor an attachment', async () => {
    const res = await POST(req({ workspaceId: 'ws-1' }), { params })
    expect(res.status).toBe(400)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('keeps the existing workspace when the dashboard context matches', async () => {
    const res = await POST(req({ workspaceId: 'ws-1', message: 'hello' }), { params })
    expect(res.status).toBe(200)
    expect(setThreadActiveWorkspaceMock).not.toHaveBeenCalled()
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', 'hello', undefined, undefined)
  })

  it('moves an ordinary thread to a different explicit dashboard workspace', async () => {
    const res = await POST(req({ workspaceId: 'ws-2', message: 'now check this workspace' }), { params })
    expect(res.status).toBe(200)
    expect(setThreadActiveWorkspaceMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1', 'ws-2')
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-2', 'thread-1', 'now check this workspace', undefined, undefined)
  })

  it('lets an authoritative linked subject outrank the selected dashboard workspace', async () => {
    resolveAuthoritativeThreadWorkspaceMock.mockResolvedValue('tropitech-ws')
    const res = await POST(req({ workspaceId: 'bimini-ws', message: "show me Mom's property" }), { params })
    expect(res.status).toBe(200)
    expect(setThreadActiveWorkspaceMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1', 'tropitech-ws')
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('tropitech-ws', 'thread-1', "show me Mom's property", undefined, undefined)
    expect(await res.json()).toMatchObject({ activeWorkspaceId: 'tropitech-ws', workspaceContextSource: 'linked_subject' })
  })

  it('fails closed if the context move loses its compare-and-swap race', async () => {
    setThreadActiveWorkspaceMock.mockResolvedValue(false)
    const res = await POST(req({ workspaceId: 'ws-2', message: 'hello' }), { params })
    expect(res.status).toBe(409)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('accepts an attachment-only send and keeps attachment scope explicit', async () => {
    const res = await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['artifact-1'] }), { params })
    expect(res.status).toBe(200)
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', '', undefined, ['artifact-1'])
  })

  it('filters non-string attachment ids', async () => {
    await POST(req({ workspaceId: 'ws-1', message: 'x', attachmentArtifactIds: ['artifact-1', 42, null, ''] }), { params })
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 'thread-1', 'x', undefined, ['artifact-1'])
  })

  it('preserves attachment error mappings', async () => {
    runFounderThreadTurnMock.mockRejectedValueOnce(new Error('Invalid attachment'))
    expect((await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['forged'] }), { params })).status).toBe(400)
    runFounderThreadTurnMock.mockRejectedValueOnce(new Error('Too many attachments'))
    expect((await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['a'] }), { params })).status).toBe(400)
    runFounderThreadTurnMock.mockRejectedValueOnce(new Error('Attachment unreadable'))
    expect((await POST(req({ workspaceId: 'ws-1', attachmentArtifactIds: ['a'] }), { params })).status).toBe(502)
  })

  it('404s a missing founder thread before any turn runs', async () => {
    getFounderThreadByIdMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1', message: 'hi' }), { params })
    expect(res.status).toBe(404)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('pins using the thread actual active workspace rather than stale client workspace', async () => {
    const res = await PATCH(patchReq({ workspaceId: 'stale-ws', pinned: true }), { params })
    expect(res.status).toBe(200)
    expect(setThreadPinnedMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1', true)
  })

  it('deletes without requiring a workspace query parameter', async () => {
    const res = await DELETE(deleteReq(), { params })
    expect(res.status).toBe(200)
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'ws-1', 'thread-1')
  })
})
