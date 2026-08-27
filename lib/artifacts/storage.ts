import 'server-only'
import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Private object storage for business artifacts (#87).
 *
 * The bucket is private (public: false, no anon/authenticated storage
 * policies — see the migration). Every read/write goes through
 * createServiceClient(), which bypasses storage RLS the same way it bypasses
 * table RLS. The ONLY way bytes ever leave this bucket is a short-lived
 * signed URL minted here, on demand, for an already-authorized caller. Never
 * expose storage_path itself as an authorization mechanism — it identifies
 * an object, it does not grant access to it.
 */

export const ARTIFACT_BUCKET = 'business-artifacts'

/** Default signed URL TTL. Long enough for one WhatsApp media-link fetch or one operator page load, short enough that a leaked URL goes stale fast. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300

/** Never trust the provider-declared mime type or a filename extension — sniff actual bytes. */
const MAGIC_BYTES: Array<{ mime: string; check: (buf: Buffer) => boolean }> = [
  { mime: 'image/jpeg', check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    check: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/gif', check: (b) => b.length > 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') },
  {
    mime: 'image/webp',
    check: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { mime: 'application/pdf', check: (b) => b.length > 4 && b.subarray(0, 4).toString('ascii') === '%PDF' },
  // OOXML (docx/xlsx) and plain zip share the PK signature — detectMimeType
  // falls back to the declared type for these rather than guessing further.
  { mime: 'application/zip', check: (b) => b.length > 2 && b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'audio/ogg', check: (b) => b.length > 4 && b.subarray(0, 4).toString('ascii') === 'OggS' },
  { mime: 'audio/mpeg', check: (b) => b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
  {
    mime: 'video/mp4',
    check: (b) => b.length > 11 && b.subarray(4, 8).toString('ascii') === 'ftyp',
  },
]

const OOXML_MIME_HINTS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * Sniff the actual bytes. Falls back to the declared mime type only for
 * container formats we can't distinguish by magic bytes alone (OOXML docs,
 * which are zip files) — never for anything with a distinguishable signature.
 */
export function detectMimeType(bytes: Buffer, declaredMimeType: string | null): string {
  for (const { mime, check } of MAGIC_BYTES) {
    if (check(bytes)) {
      if (mime === 'application/zip' && declaredMimeType && OOXML_MIME_HINTS[declaredMimeType]) {
        return OOXML_MIME_HINTS[declaredMimeType]
      }
      if (mime === 'application/zip') return declaredMimeType || 'application/zip'
      return mime
    }
  }
  // CSV/plain text has no magic bytes — trust the declared type if present.
  return declaredMimeType || 'application/octet-stream'
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
}

/** {workspace_id}/{artifact_id}/original.<ext> — never derived from the provider filename. */
export function buildStoragePath(workspaceId: string, artifactId: string, mimeType: string): string {
  const ext = EXTENSION_BY_MIME[mimeType] ?? 'bin'
  return `${workspaceId}/${artifactId}/original.${ext}`
}

export async function uploadArtifactBytes(params: {
  path: string
  bytes: Buffer
  mimeType: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase.storage.from(ARTIFACT_BUCKET).upload(params.path, params.bytes, {
    contentType: params.mimeType,
    upsert: false,
  })
  if (error) {
    // Same object re-uploaded (retry after a partial failure) is fine.
    if (/already exists|duplicate/i.test(error.message)) return { ok: true }
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function downloadArtifactBytes(path: string): Promise<Buffer | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.storage.from(ARTIFACT_BUCKET).download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** Mints a short-lived signed URL. This is the ONLY sanctioned way bytes leave the bucket. */
export async function signArtifactUrl(
  path: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS
): Promise<string | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.storage.from(ARTIFACT_BUCKET).createSignedUrl(path, ttlSeconds)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

export async function deleteArtifactBytes(path: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { error } = await supabase.storage.from(ARTIFACT_BUCKET).remove([path])
  return !error
}
