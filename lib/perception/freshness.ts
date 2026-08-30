import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

export type PerceptionFreshnessSweepResult = {
  status: 'completed'
  checked_at: string
  sources_marked_stale: number
  capabilities_downgraded: number
  devices_marked_stale: number
  events_emitted: number
}

export async function runPerceptionFreshnessSweep(
  now = new Date(),
): Promise<PerceptionFreshnessSweepResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Invalid freshness sweep timestamp')
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('refresh_perception_freshness', {
    p_now: now.toISOString(),
  })

  if (error) {
    throw new Error(`Perception freshness sweep failed: ${error.message}`)
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || data.status !== 'completed') {
    throw new Error('Perception freshness sweep returned an invalid result')
  }

  return {
    status: 'completed',
    checked_at: String(data.checked_at),
    sources_marked_stale: Number(data.sources_marked_stale ?? 0),
    capabilities_downgraded: Number(data.capabilities_downgraded ?? 0),
    devices_marked_stale: Number(data.devices_marked_stale ?? 0),
    events_emitted: Number(data.events_emitted ?? 0),
  }
}
