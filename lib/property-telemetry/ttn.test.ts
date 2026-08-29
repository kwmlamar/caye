import { describe, expect, it } from 'vitest'
import { normalizeTtnUplink } from './ttn'

function basePayload(decoded: Record<string, unknown> = {}) {
  return {
    end_device_ids: {
      device_id: 'tank-a-radar',
      application_ids: { application_id: 'moms-property-water' },
    },
    received_at: '2026-08-28T23:15:00.000Z',
    correlation_ids: ['as:up:abc'],
    uplink_message: {
      f_cnt: 42,
      f_port: 2,
      session_key_id: 'session-123',
      received_at: '2026-08-28T23:14:59.000Z',
      decoded_payload: decoded,
      rx_metadata: [
        {
          gateway_ids: { gateway_id: 'house-gateway' },
          rssi: -89,
          snr: 7.25,
        },
      ],
    },
  }
}

describe('normalizeTtnUplink', () => {
  it('normalizes raw radar distance and battery without inventing derived water state', () => {
    const result = normalizeTtnUplink(basePayload({ Distance_cm: 137, BatV: 3.91 }))

    expect(result.provider).toBe('ttn')
    expect(result.providerApplicationId).toBe('moms-property-water')
    expect(result.providerDeviceId).toBe('tank-a-radar')
    expect(result.providerEventId).toBe(
      'moms-property-water:tank-a-radar:session:session-123:f_cnt:42',
    )
    expect(result.observedAt).toBe('2026-08-28T23:14:59.000Z')
    expect(result.metrics).toEqual([
      { metricKey: 'radar_distance', numericValue: 137, unit: 'cm', quality: 'raw_sensor' },
      { metricKey: 'battery_voltage', numericValue: 3.91, unit: 'V', quality: 'raw_sensor' },
    ])
    expect(result.metrics.map((metric) => metric.metricKey)).not.toContain('tank_level_percent')
    expect(result.metrics.map((metric) => metric.metricKey)).not.toContain('stored_gallons')
    expect(result.radioMetadata).toMatchObject({
      f_cnt: 42,
      f_port: 2,
      session_key_id: 'session-123',
      rssi: -89,
      snr: 7.25,
      gateway_id: 'house-gateway',
    })
  })

  it('accepts explicit decoder aliases and numeric strings', () => {
    const result = normalizeTtnUplink(basePayload({ distance: '155.5', battery_voltage: '4.02' }))
    expect(result.metrics).toEqual([
      { metricKey: 'radar_distance', numericValue: 155.5, unit: 'cm', quality: 'raw_sensor' },
      { metricKey: 'battery_voltage', numericValue: 4.02, unit: 'V', quality: 'raw_sensor' },
    ])
  })

  it('retains a valid event even when no supported decoded metrics exist', () => {
    const result = normalizeTtnUplink(basePayload({ temperature: 29 }))
    expect(result.metrics).toEqual([])
  })

  it('uses a correlation id when frame counter is absent', () => {
    const payload = basePayload({ Distance: 100 })
    delete (payload.uplink_message as { f_cnt?: number }).f_cnt
    const result = normalizeTtnUplink(payload)
    expect(result.providerEventId).toBe('as:up:abc')
  })

  it('does not collide across LoRaWAN sessions when frame counters reset', () => {
    const first = normalizeTtnUplink(basePayload({ Distance: 100 }))
    const secondPayload = basePayload({ Distance: 100 })
    secondPayload.uplink_message.session_key_id = 'session-456'
    const second = normalizeTtnUplink(secondPayload)

    expect(first.providerEventId).not.toBe(second.providerEventId)
  })

  it('falls back to device + frame counter when session id is unavailable', () => {
    const payload = basePayload({ Distance: 100 })
    delete (payload.uplink_message as { session_key_id?: string }).session_key_id
    const result = normalizeTtnUplink(payload)
    expect(result.providerEventId).toBe('moms-property-water:tank-a-radar:f_cnt:42')
  })

  it('rejects malformed payloads rather than guessing device identity', () => {
    expect(() => normalizeTtnUplink({ uplink_message: { decoded_payload: {} } })).toThrow(
      'Invalid TTN uplink payload',
    )
  })

  it('rejects malformed timestamps before they reach the database', () => {
    const payload = basePayload({ Distance: 100 })
    payload.uplink_message.received_at = 'definitely-not-a-time'
    expect(() => normalizeTtnUplink(payload)).toThrow('Invalid uplink received_at')
  })
})
