import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { readGa4Snapshot } from './providers/ga4'

type GrowthSourceRow = {
  id: string
  workspace_id: string
  provider: 'ga4' | 'search_console' | 'bookings' | 'inquiries' | 'manual'
  status: 'connected' | 'disconnected' | 'error'
  external_account_ref: string | null
}

export type GrowthIngestSummary = {
  workspaceId: string
  attempted: string[]
  observed: string[]
  unavailable: Array<{ provider: string; reason: string }>
}

/**
 * Pulls external growth evidence for one workspace and writes only normalized
 * observations/source health. No diagnosis generation and no marketing action
 * occurs here. Provider failure updates source health but NEVER inserts a zero.
 */
export async function runGrowthIngestion(workspaceId: string): Promise<GrowthIngestSummary> {
  const supabase = createServiceClient()
  const summary: GrowthIngestSummary = { workspaceId, attempted: [], observed: [], unavailable: [] }

  const { data, error } = await supabase
    .from('growth_sources')
    .select('id,workspace_id,provider,status,external_account_ref')
    .eq('workspace_id', workspaceId)

  if (error) throw new Error('growth_sources_unavailable')

  for (const source of (data ?? []) as GrowthSourceRow[]) {
    if (source.status === 'disconnected') continue
    if (source.provider !== 'ga4') continue

    summary.attempted.push(source.provider)
    const propertyId = source.external_account_ref
    if (!propertyId) {
      await markUnavailable(source.id, 'missing_property_id')
      summary.unavailable.push({ provider: source.provider, reason: 'missing_property_id' })
      continue
    }

    const result = await readGa4Snapshot(propertyId)
    if (result.status === 'unavailable') {
      await markUnavailable(source.id, result.reason)
      summary.unavailable.push({ provider: source.provider, reason: result.reason })
      continue
    }

    const observedAt = new Date().toISOString()
    const rows = result.metrics.map((metric) => ({
      workspace_id: workspaceId,
      source_id: source.id,
      metric_key: metric.metricKey,
      metric_value: metric.value,
      metric_unit: metric.unit,
      observed_at: observedAt,
      period_start: result.periodStart,
      period_end: result.periodEnd,
      dimension: {},
      provenance: result.provenance,
    }))

    const { error: insertError } = await supabase.from('growth_observations').insert(rows)
    if (insertError) {
      await markUnavailable(source.id, 'observation_write_failed')
      summary.unavailable.push({ provider: source.provider, reason: 'observation_write_failed' })
      continue
    }

    await supabase
      .from('growth_sources')
      .update({
        status: 'connected',
        last_success_at: observedAt,
        last_error_at: null,
        last_error_code: null,
        updated_at: observedAt,
      })
      .eq('id', source.id)
      .eq('workspace_id', workspaceId)

    summary.observed.push(source.provider)
  }

  return summary

  async function markUnavailable(sourceId: string, reason: string) {
    const now = new Date().toISOString()
    await supabase
      .from('growth_sources')
      .update({ status: 'error', last_error_at: now, last_error_code: reason, updated_at: now })
      .eq('id', sourceId)
      .eq('workspace_id', workspaceId)
  }
}
