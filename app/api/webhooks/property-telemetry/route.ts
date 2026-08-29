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
  const { data: device, error: deviceError } = await supabase
    .from('property_sensor_devices')
    .select('id, workspace_id, property_id')
    .eq('provider', normalized.provider)
    .eq('provider_application_id', normalized.providerApplicationId)
    .eq('provider_device_id', normalized.providerDeviceId)
    .maybeSingle()

  if (deviceError) {
    console.error('[property-telemetry] Device lookup failed:', deviceError)
    return NextResponse.json({ error: 'Device lookup failed' }, { status: 500 })
  }
  if (!device) {
    // Do not auto-enrol hardware from an inbound webhook. Device-to-property authority is explicit.
    return NextResponse.json({ error: 'Unknown telemetry device' }, { status: 404 })
  }

  const eventRow = {
    workspace_id: device.workspace_id,
    property_id: device.property_id,
    device_id: device.id,
    provider: normalized.provider,
    provider_event_id: normalized.providerEventId,
    observed_at: normalized.observedAt,
    raw_payload: payload,
    radio_metadata: normalized.radioMetadata,
    processing_status: normalized.metrics.length > 0 ? 'normalized' : 'rejected',
    rejection_reason: normalized.metrics.length > 0 ? null : 'No supported sensor metrics in decoded payload',
  }

  const { data: event, error: eventError } = await supabase
    .from('property_telemetry_events')
    .insert(eventRow)
    .select('id')
    .single()

  if (eventError) {
    if (eventError.code === '23505') {
      return NextResponse.json({ status: 'ok', duplicate: true }, { status: 200 })
    }
    console.error('[property-telemetry] Raw event insert failed:', eventError)
    return NextResponse.json({ error: 'Telemetry event persistence failed' }, { status: 500 })
  }

  if (normalized.metrics.length > 0) {
    const rows = normalized.metrics.map((metric) => ({
      workspace_id: device.workspace_id,
      property_id: device.property_id,
      device_id: device.id,
      event_id: event.id,
      metric_key: metric.metricKey,
      numeric_value: metric.numericValue,
      unit: metric.unit,
      observed_at: normalized.observedAt,
      quality: metric.quality,
    }))

    const { error: measurementError } = await supabase
      .from('property_telemetry_measurements')
      .insert(rows)

    if (measurementError) {
      console.error('[property-telemetry] Measurement insert failed:', measurementError)
      return NextResponse.json({ error: 'Telemetry normalization failed' }, { status: 500 })
    }
  }

  const { error: deviceUpdateError } = await supabase
    .from('property_sensor_devices')
    .update({
      last_seen_at: normalized.observedAt,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id)

  if (deviceUpdateError) {
    console.error('[property-telemetry] Device heartbeat update failed:', deviceUpdateError)
    return NextResponse.json({ error: 'Device heartbeat update failed' }, { status: 500 })
  }

  return NextResponse.json(
    {
      status: 'ok',
      duplicate: false,
      event_id: event.id,
      normalized_metrics: normalized.metrics.map((metric) => metric.metricKey),
    },
    { status: 200 },
  )
}
