import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}))

import { POST } from './route'

function payload(decoded: Record<string, unknown> = { Distance_cm: 137, BatV: 3.91 }) {
  return {
    end_device_ids: {
      device_id: 'tank-a-radar',
      application_ids: { application_id: 'moms-property-water' },
    },
    correlation_ids: ['as:up:abc'],
    uplink_message: {
      f_cnt: 42,
      f_port: 2,
      session_key_id: 'session-123',
      received_at: '2026-08-28T23:14:59.000Z',
      decoded_payload: decoded,
      rx_metadata: [],
    },
  }
}

function request(body: unknown, secret = 'telemetry-secret') {
  return new NextRequest('http://localhost/api/webhooks/property-telemetry', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  })
}

describe('property telemetry webhook perception boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PROPERTY_TELEMETRY_WEBHOOK_SECRET = 'telemetry-secret'
  })

  it('fails closed before database access when the presented secret is wrong', async () => {
    const res = await POST(request(payload(), 'wrong-secret'))
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('does not auto-enrol an unknown device', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'unknown_device' }, error: null })
    const res = await POST(request(payload()))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Unknown telemetry device' })
  })

  it('returns 500 on persistence failure so the provider can retry', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    const res = await POST(request(payload()))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Telemetry persistence failed' })
  })

  it('treats a same-source database duplicate as an idempotent success', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'duplicate', event_id: 'event-1', metric_count: 2 }, error: null })
    const res = await POST(request(payload()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', duplicate: true, event_id: 'event-1' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('reports accepted normalized telemetry without granting any action authority', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'accepted', event_id: 'event-2', workspace_event_id: 17, metric_count: 2, change_kind: 'ordinary_change' },
      error: null,
    })
    const res = await POST(request(payload()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      status: 'ok',
      duplicate: false,
      event_id: 'event-2',
      normalized_metrics: ['radar_distance', 'battery_voltage'],
    })
    expect(JSON.stringify(body)).not.toContain('action')
    expect(JSON.stringify(body)).not.toContain('authority')
  })

  it('retains authenticated unsupported telemetry as a valid zero-metric ingest result', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'accepted', event_id: 'event-3', metric_count: 0 }, error: null })
    const res = await POST(request(payload({ temperature: 29 })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      duplicate: false,
      event_id: 'event-3',
      normalized_metrics: [],
    })
  })
})
