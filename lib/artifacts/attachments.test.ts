import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const getArtifactDetail = vi.hoisted(() => vi.fn())
vi.mock('./query', () => ({ getArtifactDetail }))

const downloadArtifactBytes = vi.hoisted(() => vi.fn())
vi.mock('./storage', () => ({ downloadArtifactBytes }))

import { resolveWorkspaceAttachments, buildAttachmentContentBlocks } from './attachments'
import type { BusinessArtifactRow } from './types'

function imageArtifact(overrides: Record<string, unknown> = {}): BusinessArtifactRow {
  return {
    id: 'artifact-1',
    workspace_id: 'ws-1',
    modality: 'image',
    detected_mime_type: 'image/png',
    declared_mime_type: 'image/png',
    storage_path: 'ws-1/artifact-1/original.png',
    filename: 'max.png',
    retention_status: 'active',
    storage_state: 'stored',
    ...overrides,
  } as unknown as BusinessArtifactRow
}

beforeEach(() => {
  getArtifactDetail.mockReset()
  downloadArtifactBytes.mockReset()
})

describe('resolveWorkspaceAttachments — tenancy re-verification (multimodal Caye Direct follow-up)', () => {
  it('resolves an id that belongs to this workspace', async () => {
    getArtifactDetail.mockResolvedValueOnce({ artifact: imageArtifact(), observations: [], relations: [] })
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['artifact-1'])
    expect(resolved).toHaveLength(1)
    expect(invalidIds).toEqual([])
    expect(getArtifactDetail).toHaveBeenCalledWith('ws-1', 'artifact-1')
  })

  it('rejects a forged/foreign-workspace id — getArtifactDetail is itself workspace-scoped and returns null', async () => {
    getArtifactDetail.mockResolvedValueOnce(null)
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['not-mine'])
    expect(resolved).toEqual([])
    expect(invalidIds).toEqual(['not-mine'])
  })

  it('rejects a tombstoned/deleted artifact even if somehow returned', async () => {
    getArtifactDetail.mockResolvedValueOnce({ artifact: imageArtifact({ retention_status: 'tombstoned' }), observations: [], relations: [] })
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['artifact-1'])
    expect(resolved).toEqual([])
    expect(invalidIds).toEqual(['artifact-1'])
  })

  it('de-dupes repeated ids and only looks each one up once', async () => {
    getArtifactDetail.mockResolvedValue({ artifact: imageArtifact(), observations: [], relations: [] })
    await resolveWorkspaceAttachments('ws-1', ['artifact-1', 'artifact-1'])
    expect(getArtifactDetail).toHaveBeenCalledTimes(1)
  })
})

describe('buildAttachmentContentBlocks — inline vision/document reading (multimodal Caye Direct follow-up)', () => {
  it('builds an image content block from real downloaded bytes for a supported image mime type', async () => {
    downloadArtifactBytes.mockResolvedValueOnce(Buffer.from('fake-bytes'))
    const { blocks, unreadableNote } = await buildAttachmentContentBlocks([{ artifact: imageArtifact() }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(unreadableNote).toBeNull()
  })

  it('builds a document content block for a PDF', async () => {
    downloadArtifactBytes.mockResolvedValueOnce(Buffer.from('%PDF-fake'))
    const pdf = imageArtifact({ modality: 'document', detected_mime_type: 'application/pdf', declared_mime_type: 'application/pdf' })
    const { blocks } = await buildAttachmentContentBlocks([{ artifact: pdf }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
  })

  it('never claims a live block for a non-PDF document — durably stored but not read inline, no crash', async () => {
    const docx = imageArtifact({
      modality: 'document',
      detected_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      declared_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const { blocks, unreadableNote } = await buildAttachmentContentBlocks([{ artifact: docx }])
    expect(blocks).toHaveLength(0)
    expect(unreadableNote).toBeNull()
    expect(downloadArtifactBytes).not.toHaveBeenCalled()
  })

  it('reports an unreadable note (plain sentence, no bracket-wrapped internal identifier) when bytes cannot be downloaded — never throws', async () => {
    downloadArtifactBytes.mockResolvedValueOnce(null)
    const { blocks, unreadableNote } = await buildAttachmentContentBlocks([{ artifact: imageArtifact() }])
    expect(blocks).toHaveLength(0)
    expect(unreadableNote).toMatch(/max\.png/)
    expect(unreadableNote).not.toMatch(/\[\$\{/) // guards against lib/no-internal-leak-paths.test.ts's shape
  })
})
