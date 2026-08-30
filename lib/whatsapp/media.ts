import 'server-only'

/** WhatsApp Cloud API media download helpers shared by operator and customer channels. */
const GRAPH_VERSION = process.env.META_API_VERSION || 'v21.0'

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

/** Resolve a Meta media id, then download its short-lived URL with the same token. */
export async function downloadWhatsAppMediaWithToken(
  mediaId: string,
  accessToken: string
): Promise<DownloadedMedia> {
  if (!mediaId?.trim()) throw new Error('WhatsApp media id is required')
  if (!accessToken?.trim()) throw new Error('WhatsApp media access token is required')

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed: ${metaRes.status} ${(await metaRes.text()).slice(0, 400)}`)
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string }
  if (!meta.url || !meta.mime_type) {
    throw new Error('WhatsApp media lookup response missing url/mime_type')
  }

  const bytesRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!bytesRes.ok) throw new Error(`WhatsApp media download failed: ${bytesRes.status}`)

  const buffer = Buffer.from(await bytesRes.arrayBuffer())
  return { base64: buffer.toString('base64'), mimeType: meta.mime_type }
}

/** Caye-platform/operator-number convenience wrapper. */
export async function downloadWhatsAppMedia(mediaId: string): Promise<DownloadedMedia> {
  const accessToken = process.env.CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN
  if (!accessToken) throw new Error('Missing CAYE_PLATFORM_WHATSAPP_ACCESS_TOKEN')
  return downloadWhatsAppMediaWithToken(mediaId, accessToken)
}
