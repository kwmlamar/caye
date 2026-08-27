/**
 * GET /api/founder/business-artifacts/:id?workspaceId=<uuid>
 *
 * Resolves a business_artifacts id crossing the Caye Direct rich_result
 * chat boundary into a short-lived signed URL — mirrors
 * app/api/founder/engineering-artifacts/[id]/route.ts exactly, same
 * "only a trusted id crosses the boundary" contract. getArtifactDetail is
 * workspace-scoped and already refuses a cross-workspace id, a tombstoned/
 * deleted artifact, or one whose bytes never confirmed durable
 * (storage_state !== 'stored') — none of that is re-implemented here.
 *
 * The signed URL is minted fresh on every call, never cached/stored — see
 * lib/artifacts/storage.ts's DEFAULT_SIGNED_URL_TTL_SECONDS. A page refresh
 * calls this again rather than replaying a stale URL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getArtifactDetail } from '@/lib/artifacts/query'
import { signArtifactUrl } from '@/lib/artifacts/storage'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  if (!(await requireFounder(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const detail = await getArtifactDetail(workspaceId, id)
  if (!detail) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })

  const url = await signArtifactUrl(detail.artifact.storage_path)
  if (!url) return NextResponse.json({ error: 'Could not prepare that file right now — try again.' }, { status: 502 })

  return NextResponse.json({
    type: 'business_artifact',
    artifact: {
      id: detail.artifact.id,
      filename: detail.artifact.filename,
      modality: detail.artifact.modality,
      mimeType: detail.artifact.detected_mime_type,
      receivedAt: detail.artifact.received_at,
      processingStatus: detail.artifact.processing_status,
      url,
    },
  })
}
