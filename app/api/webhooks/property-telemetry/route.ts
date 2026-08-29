import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { normalizeTtnUplink } from '@/lib/property-telemetry/ttn'

function constantTimeSecretMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function presentedSecret(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return request.headers.get('x-caye-telemetry-secret')
}

export async function POST(request: NextRequest) {
  const secret = process.env.PROPERTY_TELEMETRY_WEBHOOK_SECRET
  if (!secret) {
    console.error('[property-telemetry] PROPERTY_TELEMETRY_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Telemetry ingestion unavailable' }, { status: 503 })
  }

  if (!constantTimeSecretMatch(presentedSecret(request), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    payload = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  let normalized
  try {
    normalized = normalizeTtnUplink(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid telemetry payload'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const supabase = createServiceClient()
  const metrics = normalized.metrics.map((metric) => ({
    metric_key: metric.metricKey,
    numeric_value: metric.numericValue,
    unit: metric.unit,
    quality: metric.quality,
  }))

  // Keep raw-event persistence, normalized measurements, and the device heartbeat in one
  // database transaction. A partial write followed by a provider retry must never look like
  // a harmless duplicate while silently losing the measurement.
  const { data: ingestResult, error: ingestError } = await supabase.rpc(
    'ingest_property_telemetry_event',
    {
      p_provider: normalized.provider,
      p_provider_application_id: normalized.providerApplicationId,
      p_provider_device_id: normalized.providerDeviceId,
      p_provider_event_id: normalized.providerEventId,
      p_observed_at: normalized.observedAt,
      p_raw_payload: payload,
      p_radio_metadata: normalized.radioMetadata,
      p_metrics: metrics,
    },
  )

  if (ingestError) {
    console.error('[property-telemetry] Atomic ingest failed:', ingestError)
    return NextResponse.json({ error: 'Telemetry persistence failed' }, { status: 500 })
  }

  const result = ingestResult && typeof ingestResult === 'object' && !Array.isArray(ingestResult)
    ? ingestResult as Record<string, unknown>
    : null

  if (!result) {
    console.error('[property-telemetry] Atomic ingest returned an invalid result')
    return NextResponse.json({ error: 'Telemetry persistence failed' }, { status: 500 })
  }

  if (result.status === 'unknown_device') {
    // Do not auto-enrol hardware from an inbound webhook. Device-to-property authority is explicit.
    return NextResponse.json({ error: 'Unknown telemetry device' }, { status: 404 })
  }

  if (result.status === 'duplicate') {
    return NextResponse.json(
      {
        status: 'ok',
        duplicate: true,
        event_id: result.event_id ?? null,
        normalized_metrics: normalized.metrics.map((metric) => metric.metricKey),
      },
      { status: 200 },
    )
  }

  if (result.status !== 'accepted') {
    console.error('[property-telemetry] Unexpected atomic ingest status:', result.status)
    return NextResponse.json({ error: 'Telemetry persistence failed' }, { status: 500 })
  }

  return NextResponse.json(
    {
      status: 'ok',
      duplicate: false,
      event_id: result.event_id ?? null,
      normalized_metrics: normalized.metrics.map((metric) => metric.metricKey),
    },
    { status: 200 },
  )
}
