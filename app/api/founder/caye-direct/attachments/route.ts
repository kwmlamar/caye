/**
 * POST /api/founder/caye-direct/attachments
 *
 * Uploads ONE file into the SAME business_artifacts pipeline WhatsApp
 * ingestion uses (lib/artifacts/ingest.ts) — Caye Direct gets no second
 * storage/attachment system. multipart/form-data: `workspaceId`, `file`,
 * and a client-generated `idempotencyKey` (used as provider_attachment_id
 * so a network retry of the SAME upload attempt resolves to the SAME
 * artifact row rather than a duplicate — see ingest.ts's dedup contract).
 *
 * This is a separate step from sending the message: the client uploads on
 * file-select (so the composer can show a real preview/remove affordance
 * before Send), then references the returned artifactId in the thread
 * POST's `attachmentArtifactIds`. Scoped to images and PDFs today, per the
 * durable artifact system's currently-supported inline-reading modalities
 * — other types the schema already anticipates (docx/audio/video/etc.)
 * are intentionally out of scope for the Direct composer for now, not
 * because the pipeline can't hold them.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS — same guard as every
 * other founder route. The founder is a cross-workspace power user (see
 * lib/founder.ts), so no additional per-workspace membership check applies
 * here, matching every other founder Caye Direct route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { ingestArtifact } from '@/lib/artifacts/ingest'
import { detectMimeType } from '@/lib/artifacts/storage'

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9_-]{1,128}$/
// Coarse, cheap-to-check ceiling before bytes are even fully buffered —
// the precise per-modality limit (CHANNEL_SIZE_LIMITS_BYTES) is enforced
// inside ingestArtifact once the real modality is known; this just rejects
// an obviously-oversized upload fast rather than after a full read.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 })
  }

  const workspaceId = form.get('workspaceId')
  const idempotencyKey = form.get('idempotencyKey')
  const file = form.get('file')

  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return NextResponse.json({ error: 'A valid idempotencyKey is required' }, { status: 400 })
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `File is too large (over ${MAX_UPLOAD_BYTES / 1024 / 1024}MB).` }, { status: 413 })
  }

  const supabase = createServiceClient()
  const operator = await resolveFounderOperator(supabase, workspaceId)

  const bytes = Buffer.from(await file.arrayBuffer())
  // Sniffed from the actual bytes ALONE — declaredMimeType is deliberately
  // omitted here (unlike the downstream ingestArtifact call below), because
  // detectMimeType falls back to the declared type when no magic-byte
  // signature matches (its documented behavior for container formats like
  // OOXML). Passing the client's declared type into THIS check would let a
  // file with no recognizable signature at all (e.g. plain text) sail
  // through on a spoofed Content-Type alone. Requiring a genuine magic-byte
  // match closes that gap: anything without one falls back to
  // 'application/octet-stream', which is never in ACCEPTED_MIME_TYPES.
  const sniffedMimeType = detectMimeType(bytes, null)
  if (!ACCEPTED_MIME_TYPES.has(sniffedMimeType)) {
    return NextResponse.json({ error: `Unsupported file type (${sniffedMimeType}). Send an image (JPEG/PNG/GIF/WebP) or a PDF.` }, { status: 400 })
  }

  const result = await ingestArtifact({
    workspaceId,
    sourceChannel: 'dashboard',
    bytes,
    declaredMimeType: file.type || null,
    filename: file.name || null,
    providerAttachmentId: idempotencyKey,
    origin: 'operator_uploaded',
    senderOperatorAllowlistId: operator?.id ?? null,
    senderLabel: operator?.name ?? 'Founder (dashboard)',
  })

  if (!result.ok) {
    const status = result.errorCode === 'TOO_LARGE' ? 413 : 502
    return NextResponse.json({ error: result.error, errorCode: result.errorCode }, { status })
  }

  return NextResponse.json({
    artifactId: result.artifact.id,
    filename: result.artifact.filename,
    modality: result.artifact.modality,
    mimeType: result.artifact.detected_mime_type,
    deduped: result.deduped,
  })
}
