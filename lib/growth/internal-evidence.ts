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

const BOOKING_METRIC_KEYS = [
  'bookings.created',
  'bookings.confirmed',
  'bookings.pending',
  'bookings.cancelled',
  'bookings.active_guests',
] as const

/**
 * Normalizes first-party booking evidence already held by Caye.
 * `bookings.user_id` is the canonical workspace/customer id in the current schema.
 * This is observed business evidence, not inferred website conversion.
 *
 * Windows use completed UTC days only. A run at any time on the same UTC date
 * therefore reads the exact same evidence window instead of claiming future hours
 * in `period_end` or changing the denominator on every retry.
 */
export async function ingestBookingEvidence(workspaceId: string, days = 28) {
  const supabase = createServiceClient()
  const now = new Date()
  const observedAt = now.toISOString()
  const snapshotDate = observedAt.slice(0, 10)

  const periodEndExclusiveDate = new Date(`${snapshotDate}T00:00:00.000Z`)
  const periodStartDate = new Date(periodEndExclusiveDate)
  periodStartDate.setUTCDate(periodStartDate.getUTCDate() - days)
  const periodEndInclusiveDate = new Date(periodEndExclusiveDate.getTime() - 1)

  const periodStart = periodStartDate.toISOString()
  const periodEndExclusive = periodEndExclusiveDate.toISOString()
  const periodEnd = periodEndInclusiveDate.toISOString()

  const { data: source, error: sourceError } = await supabase
    .from('growth_sources')
    .upsert(
      { workspace_id: workspaceId, provider: 'bookings', status: 'connected', updated_at: observedAt },
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
    .lt('created_at', periodEndExclusive)

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

  const provenance = {
    provider: 'caye_bookings',
    query_window_days: days,
    window_basis: 'completed_utc_days',
    snapshot_date: snapshotDate,
    period_end_exclusive: periodEndExclusive,
    captured_at: observedAt,
  }
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
    observed_at: observedAt,
    period_start: periodStart,
    period_end: periodEnd,
    dimension: {},
    provenance,
  }))

  // A same-day retry replaces only this aggregate booking snapshot. Do not erase
  // future dimensional observations that may share the same source.
  const { error: deleteError } = await supabase
    .from('growth_observations')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('source_id', source.id)
    .in('metric_key', [...BOOKING_METRIC_KEYS])
    .gte('observed_at', `${snapshotDate}T00:00:00.000Z`)
    .lte('observed_at', `${snapshotDate}T23:59:59.999Z`)
  if (deleteError) throw new Error('booking_observation_dedupe_failed')

  const { error: writeError } = await supabase.from('growth_observations').insert(observations)
  if (writeError) throw new Error('booking_observation_write_failed')

  const { error: sourceUpdateError } = await supabase
    .from('growth_sources')
    .update({ status: 'connected', last_success_at: observedAt, last_error_at: null, last_error_code: null, updated_at: observedAt })
    .eq('id', source.id)
    .eq('workspace_id', workspaceId)
  if (sourceUpdateError) throw new Error('booking_growth_source_update_failed')

  return counts
}
