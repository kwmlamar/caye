export type NormalizedTelemetryMetric = {
  metricKey: string
  numericValue: number
  unit: string
  quality: 'raw_sensor'
}

export type NormalizedTtnUplink = {
  provider: 'ttn'
  providerApplicationId: string
  providerDeviceId: string
  providerEventId: string
  observedAt: string
  radioMetadata: Record<string, unknown>
  metrics: NormalizedTelemetryMetric[]
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(record[key])
    if (value !== null) return value
  }
  return null
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${label}`)
  }
  return value.trim()
}

/**
 * Normalize a The Things Stack uplink while keeping provider-specific shape at the edge.
 * This intentionally stores only raw sensor facts here. Water depth, percentage, gallons,
 * consumption, and autonomy require calibration/context and belong in a later derivation step.
 */
export function normalizeTtnUplink(payload: JsonRecord): NormalizedTtnUplink {
  const endDeviceIds = asRecord(payload.end_device_ids)
  const applicationIds = asRecord(endDeviceIds?.application_ids)
  const uplink = asRecord(payload.uplink_message)
  const decoded = asRecord(uplink?.decoded_payload)

  if (!endDeviceIds || !applicationIds || !uplink || !decoded) {
    throw new Error('Invalid TTN uplink payload')
  }

  const providerApplicationId = requiredString(applicationIds.application_id, 'application id')
  const providerDeviceId = requiredString(endDeviceIds.device_id, 'device id')
  const observedAt = requiredString(
    uplink.received_at ?? payload.received_at,
    'uplink received_at',
  )

  const frameCounter = finiteNumber(uplink.f_cnt)
  const correlationIds = Array.isArray(payload.correlation_ids)
    ? payload.correlation_ids.filter((value): value is string => typeof value === 'string')
    : []

  // TTS correlation IDs are useful but not guaranteed to be stable across every integration.
  // Device + application + frame counter is stable for normal uplinks; received_at is a fallback.
  const providerEventId = frameCounter !== null
    ? `${providerApplicationId}:${providerDeviceId}:f_cnt:${frameCounter}`
    : correlationIds[0] || `${providerApplicationId}:${providerDeviceId}:at:${observedAt}`

  const metrics: NormalizedTelemetryMetric[] = []

  // Dragino decoders have used slightly different labels across firmware/decoder versions.
  // Accept only explicit aliases and normalize them at this boundary.
  const distanceCm = firstNumber(decoded, [
    'distance_cm',
    'Distance_cm',
    'distance',
    'Distance',
  ])
  if (distanceCm !== null) {
    metrics.push({ metricKey: 'radar_distance', numericValue: distanceCm, unit: 'cm', quality: 'raw_sensor' })
  }

  const batteryVolts = firstNumber(decoded, [
    'battery_voltage',
    'battery_v',
    'BatV',
    'Battery',
  ])
  if (batteryVolts !== null) {
    metrics.push({ metricKey: 'battery_voltage', numericValue: batteryVolts, unit: 'V', quality: 'raw_sensor' })
  }

  const rssi = firstNumber(uplink, ['rssi'])
  const snr = firstNumber(uplink, ['snr'])

  const rxMetadata = Array.isArray(uplink.rx_metadata) ? uplink.rx_metadata : []
  const firstRx = asRecord(rxMetadata[0])
  const firstGateway = asRecord(firstRx?.gateway_ids)

  const radioMetadata: Record<string, unknown> = {
    f_cnt: frameCounter,
    f_port: finiteNumber(uplink.f_port),
    rssi: rssi ?? finiteNumber(firstRx?.rssi),
    snr: snr ?? finiteNumber(firstRx?.snr),
    gateway_id: firstGateway?.gateway_id ?? null,
    correlation_ids: correlationIds,
  }

  return {
    provider: 'ttn',
    providerApplicationId,
    providerDeviceId,
    providerEventId,
    observedAt,
    radioMetadata,
    metrics,
  }
}
