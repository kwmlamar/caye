import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getFounderPropertySnapshot } from '@/lib/property/store'

type GeoAnchor = { lat?: unknown; lng?: unknown }

function validCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Founder-authenticated satellite image proxy.
 *
 * GOOGLE_MAPS_API_KEY stays server-side. The browser never receives the key,
 * and callers cannot turn this into a generic map proxy because center/zoom
 * are derived from the canonical property's stored geo anchor.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Satellite imagery is not configured' }, { status: 503 })

  const { id } = await params
  const snapshot = await getFounderPropertySnapshot(id)
  if (!snapshot) return NextResponse.json({ error: 'Property not found' }, { status: 404 })

  const geo = snapshot.property.metadata?.geo as GeoAnchor | undefined
  if (!validCoordinate(geo?.lat, -90, 90) || !validCoordinate(geo?.lng, -180, 180)) {
    return NextResponse.json({ error: 'Property geo anchor is not configured' }, { status: 409 })
  }

  const query = new URLSearchParams({
    center: `${geo.lat},${geo.lng}`,
    zoom: '20',
    size: '640x420',
    scale: '2',
    maptype: 'satellite',
    key: apiKey,
  })

  let upstream: Response
  try {
    upstream = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${query.toString()}`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
    })
  } catch {
    return NextResponse.json({ error: 'Satellite provider unavailable' }, { status: 502 })
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: 'Satellite provider rejected the request' }, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    return NextResponse.json({ error: 'Satellite provider returned an invalid response' }, { status: 502 })
  }

  const image = await upstream.arrayBuffer()
  return new NextResponse(image, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=900',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
