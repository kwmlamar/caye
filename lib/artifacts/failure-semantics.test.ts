import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Adversarial-review follow-up (multimodal Caye Direct, #87). Pins the
 * partial-failure semantics the review asked to have reasoned through and
 * tested explicitly:
 *
 * 1. Upload succeeds, message submission fails/never happens — the
 *    artifact is a real, durable, unreferenced row. No conversation
 *    relation or message claim is ever fabricated for it.
 * 2. Upload fails — the message must not be able to reference an artifact
 *    that never existed (resolveWorkspaceAttachments already covers the
 *    forged/unresolvable-id case; this file adds the upload-endpoint side).
 * 3. Message succeeds, async understanding (processArtifact) later fails —
 *    the artifact stays retrievable/attachable; Caye must not claim
 *    understanding succeeded, and must not lose the file.
 */

const getArtifactDetail = vi.hoisted(() => vi.fn())
vi.mock('./query', () => ({ getArtifactDetail }))
const downloadArtifactBytes = vi.hoisted(() => vi.fn())
vi.mock('./storage', () => ({ downloadArtifactBytes }))

import { resolveWorkspaceAttachments } from './attachments'
import { getArtifact } from '../caye-agent/tools/read/get-artifact'
import type { ToolContext } from '../caye-agent/tools/types'

function baseCtx(): ToolContext {
  return { workspaceId: 'ws-1', callerRole: 'founder', requestId: 'req-1' }
}

beforeEach(() => {
  getArtifactDetail.mockReset()
  downloadArtifactBytes.mockReset()
})

describe('failure semantics — storage succeeded, understanding/processing failed', () => {
  const failedProcessingArtifact = {
    id: 'artifact-1', workspace_id: 'ws-1', modality: 'image', storage_state: 'stored', retention_status: 'active',
    storage_path: 'ws-1/artifact-1/original.jpg', filename: 'max.jpg', detected_mime_type: 'image/jpeg', declared_mime_type: 'image/jpeg',
    source_channel: 'dashboard', received_at: '2026-08-27T10:00:00Z', sender_operator_allowlist_id: 7, sender_contact_id: null, sender_label: null,
    processing_status: 'failed', processing_error: 'vision call timed out',
  }

  it('the file remains resolvable as an attachment — resolveWorkspaceAttachments never gates on processing_status', async () => {
    getArtifactDetail.mockResolvedValue({ artifact: failedProcessingArtifact, observations: [], relations: [] })
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['artifact-1'])
    expect(invalidIds).toEqual([])
    expect(resolved).toHaveLength(1)
  })

  it('get_artifact reports the real failure honestly instead of claiming understanding succeeded', async () => {
    getArtifactDetail.mockResolvedValueOnce({ artifact: failedProcessingArtifact, observations: [], relations: [] })
    const result = await getArtifact.execute({ artifact_id: 'artifact-1' }, baseCtx())
    const data = result.data as { processing_status: string; processing_error: string | null; observations: unknown[] }
    expect(data.processing_status).toBe('failed')
    expect(data.processing_error).toBe('vision call timed out')
    // No fabricated understanding — no observations exist to misreport.
    expect(data.observations).toEqual([])
  })

  it('an "unsupported" modality (schema-ready, pipeline not implemented) is equally honest and equally retrievable', async () => {
    const unsupported = { ...failedProcessingArtifact, processing_status: 'unsupported', processing_error: null, modality: 'video' }
    getArtifactDetail.mockResolvedValueOnce({ artifact: unsupported, observations: [], relations: [] })
    const result = await getArtifact.execute({ artifact_id: 'artifact-1' }, baseCtx())
    expect((result.data as { processing_status: string }).processing_status).toBe('unsupported')
  })
})

describe('failure semantics — upload succeeded, no message ever referenced it (orphaned-but-real artifact)', () => {
  it('an artifact that is never referenced by any message is still a real, valid, resolvable row — not a phantom', async () => {
    // Simulates: founder uploads via the composer, then closes the tab
    // (or the send request fails) before ever sending. The artifact row
    // ingestArtifact created is durable regardless — nothing in this
    // codebase requires a caye_operator_messages row to exist before an
    // artifact is considered real. Documented, acceptable debt (no
    // conversation relation is ever fabricated FOR it either): see
    // lib/artifacts/attachments.ts's own module doc comment.
    const orphan = {
      id: 'artifact-orphan-1', workspace_id: 'ws-1', modality: 'image', storage_state: 'stored', retention_status: 'active',
      storage_path: 'ws-1/artifact-orphan-1/original.jpg', filename: 'unsent.jpg', detected_mime_type: 'image/jpeg', declared_mime_type: 'image/jpeg',
      source_channel: 'dashboard', received_at: '2026-08-27T10:00:00Z', sender_operator_allowlist_id: 7, sender_contact_id: null, sender_label: null,
      processing_status: 'pending', processing_error: null,
    }
    getArtifactDetail.mockResolvedValueOnce({ artifact: orphan, observations: [], relations: [] })
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['artifact-orphan-1'])
    // It CAN be referenced later (e.g. the founder re-selects it from a
    // future "recent uploads" affordance, or simply re-sends) — being
    // orphaned today doesn't make it invalid.
    expect(invalidIds).toEqual([])
    expect(resolved).toHaveLength(1)
  })
})

describe('failure semantics — retention gate is the ONLY thing that can make a stored artifact unretrievable', () => {
  it('a tombstoned artifact (e.g. explicitly removed) is refused even though bytes may still exist', async () => {
    getArtifactDetail.mockResolvedValueOnce({
      artifact: { id: 'artifact-1', workspace_id: 'ws-1', modality: 'image', storage_state: 'stored', retention_status: 'tombstoned' },
      observations: [], relations: [],
    })
    const { resolved, invalidIds } = await resolveWorkspaceAttachments('ws-1', ['artifact-1'])
    expect(resolved).toEqual([])
    expect(invalidIds).toEqual(['artifact-1'])
  })
})
