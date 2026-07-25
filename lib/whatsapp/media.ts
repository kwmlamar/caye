import 'server-only'

/**
 * Downloads media (images, for now) from the WhatsApp Cloud API for the
 * Caye-platform number. Distinct from lib/whatsapp/outbound.ts (which only
 * sends) but shares its creds/version conventions.
 *
 * Meta's media fetch is a two-step dance: resolve media_id to a short-lived
 * signed URL, then GET that URL with the same bearer token to get bytes.
 */

const GRAPH_VERSION = 'v19.0'

// Anthropic's image content block only accepts these four media types.
export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

export function isSupportedImageMimeType(mimeType: string): mimeType is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
}

export interface DownloadedMedia {
  base64: string
  mimeType: string
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<DownloadedMedia> {
  const accessToken = process.env.CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error('Missing CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN')
  }

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed: ${metaRes.status} ${await metaRes.text()}`)
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
  if (!meta.url || !meta.mime_type) {
    throw new Error('WhatsApp media lookup response missing url/mime_type')
  }

  const bytesRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!bytesRes.ok) {
    throw new Error(`WhatsApp media download failed: ${bytesRes.status}`)
  }
  const buffer = Buffer.from(await bytesRes.arrayBuffer())

  return { base64: buffer.toString('base64'), mimeType: meta.mime_type }
}
