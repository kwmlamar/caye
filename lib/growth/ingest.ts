import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { ingestBookingEvidence } from './internal-evidence'
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

export async function runAllGrowthIngestion(): Promise<{ workspaces: GrowthIngestSummary[] }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('growth_sources').select('workspace_id')
  if (error) throw new Error('growth_sources_unavailable')

  const workspaceIds = Array.from(new Set((data ?? []).map((row) => row.workspace_id as string)))
  const workspaces: GrowthIngestSummary[] = []
  for (const workspaceId of workspaceIds) workspaces.push(await runGrowthIngestion(workspaceId))
  return { workspaces }
}

/**
 * Normalizes first-party booking evidence and any configured external providers.
 * A disconnected external source with no account reference is intentionally skipped.
 * Once an account reference is configured, Caye probes it without pre-declaring success;
 * only a successful API read promotes the source to connected.
 * Provider failure updates source health but NEVER inserts a zero for unavailable data.
 * No marketing action occurs here.
 */
export async function runGrowthIngestion(workspaceId: string): Promise<GrowthIngestSummary> {
  const supabase = createServiceClient()
  const summary: GrowthIngestSummary = { workspaceId, attempted: [], observed: [], unavailable: [] }

  try {
    await ingestBookingEvidence(workspaceId)
    summary.attempted.push('bookings')
    summary.observed.push('bookings')
  } catch {
    summary.attempted.push('bookings')
    summary.unavailable.push({ provider: 'bookings', reason: 'booking_evidence_unavailable' })
  }

  const { data, error } = await supabase
    .from('growth_sources')
    .select('id,workspace_id,provider,status,external_account_ref')
    .eq('workspace_id', workspaceId)

  if (error) throw new Error('growth_sources_unavailable')

  for (const source of (data ?? []) as GrowthSourceRow[]) {
    if (source.provider !== 'ga4') continue

    const propertyId = source.external_account_ref
    if (!propertyId) {
      if (source.status === 'disconnected') {
        summary.unavailable.push({ provider: source.provider, reason: 'source_disconnected' })
        continue
      }
      await markUnavailable(source.id, 'missing_property_id')
      summary.unavailable.push({ provider: source.provider, reason: 'missing_property_id' })
      continue
    }

    summary.attempted.push(source.provider)
    const result = await readGa4Snapshot(propertyId)
    if (result.status === 'unavailable') {
      await markUnavailable(source.id, result.reason)
      summary.unavailable.push({ provider: source.provider, reason: result.reason })
      continue
    }

    const observedAt = new Date().toISOString()
    const snapshotDate = observedAt.slice(0, 10)

    // Replace same-day GA4 topline observations so retries do not manufacture evidence.
    const { error: deleteError } = await supabase
      .from('growth_observations')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('source_id', source.id)
      .gte('observed_at', `${snapshotDate}T00:00:00.000Z`)
      .lte('observed_at', `${snapshotDate}T23:59:59.999Z`)
    if (deleteError) {
      await markUnavailable(source.id, 'observation_dedupe_failed')
      summary.unavailable.push({ provider: source.provider, reason: 'observation_dedupe_failed' })
      continue
    }

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
      provenance: { ...result.provenance, captured_at: observedAt },
    }))

    const { error: insertError } = await supabase.from('growth_observations').insert(rows)
    if (insertError) {
      await markUnavailable(source.id, 'observation_write_failed')
      summary.unavailable.push({ provider: source.provider, reason: 'observation_write_failed' })
      continue
    }

    const { error: sourceUpdateError } = await supabase
      .from('growth_sources')
      .update({ status: 'connected', last_success_at: observedAt, last_error_at: null, last_error_code: null, updated_at: observedAt })
      .eq('id', source.id)
      .eq('workspace_id', workspaceId)
    if (sourceUpdateError) {
      summary.unavailable.push({ provider: source.provider, reason: 'source_health_update_failed' })
      continue
    }

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
