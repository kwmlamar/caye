import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

type ObservationInsert = {
  workspace_id: string
  source_id: string
  metric_key: string
  metric_value: number
  metric_unit: string
  observed_at: string
  period_start: string
  period_end: string
  dimension: Record<string, unknown>
  provenance: Record<string, unknown>
}

/**
 * Normalizes first-party booking evidence already held by Caye.
 * `bookings.user_id` is the canonical workspace/customer id in the current schema.
 * This is observed business evidence, not inferred website conversion.
 */
export async function ingestBookingEvidence(workspaceId: string, days = 28) {
  const supabase = createServiceClient()
  const now = new Date()
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const periodStart = start.toISOString()
  const periodEnd = now.toISOString()

  const { data: source, error: sourceError } = await supabase
    .from('growth_sources')
    .upsert(
      { workspace_id: workspaceId, provider: 'bookings', status: 'connected', updated_at: periodEnd },
      { onConflict: 'workspace_id,provider' },
    )
    .select('id')
    .single()

  if (sourceError || !source?.id) throw new Error('booking_growth_source_unavailable')

  const { data, error } = await supabase
    .from('bookings')
    .select('status,number_of_people')
    .eq('user_id', workspaceId)
    .gte('created_at', periodStart)
    .lte('created_at', periodEnd)

  if (error) throw new Error('booking_evidence_unavailable')

  const rows = (data ?? []) as Array<{ status: string | null; number_of_people: number | null }>
  const counts = { total: rows.length, confirmed: 0, pending: 0, cancelled: 0, activeGuests: 0 }
  for (const row of rows) {
    const status = (row.status ?? '').toLowerCase()
    if (status === 'confirmed') counts.confirmed += 1
    if (status === 'pending') counts.pending += 1
    if (status === 'cancelled') counts.cancelled += 1
    if (status === 'confirmed' || status === 'pending') counts.activeGuests += row.number_of_people ?? 0
  }

  const provenance = { provider: 'caye_bookings', query_window_days: days, captured_at: periodEnd }
  const observations: ObservationInsert[] = [
    ['bookings.created', counts.total, 'count'],
    ['bookings.confirmed', counts.confirmed, 'count'],
    ['bookings.pending', counts.pending, 'count'],
    ['bookings.cancelled', counts.cancelled, 'count'],
    ['bookings.active_guests', counts.activeGuests, 'people'],
  ].map(([metricKey, value, unit]) => ({
    workspace_id: workspaceId,
    source_id: source.id,
    metric_key: metricKey as string,
    metric_value: value as number,
    metric_unit: unit as string,
    observed_at: periodEnd,
    period_start: periodStart,
    period_end: periodEnd,
    dimension: {},
    provenance,
  }))

  const { error: writeError } = await supabase.from('growth_observations').insert(observations)
  if (writeError) throw new Error('booking_observation_write_failed')

  await supabase
    .from('growth_sources')
    .update({ status: 'connected', last_success_at: periodEnd, last_error_at: null, last_error_code: null, updated_at: periodEnd })
    .eq('id', source.id)
    .eq('workspace_id', workspaceId)

  return counts
}
