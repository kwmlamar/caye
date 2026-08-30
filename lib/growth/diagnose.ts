import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

type Observation = { id: string; metric_key: string; metric_value: number | null; observed_at: string }
type Source = { provider: string; status: string; last_success_at: string | null }

type Diagnosis = {
  key: string
  headline: string
  explanation: string
  confidence: number
  evidenceIds: string[]
  missingSources: string[]
  freshness: 'fresh' | 'stale' | 'insufficient'
  recommendation: { title: string; rationale: string; priority: number; action: Record<string, unknown> }
}

/**
 * Deterministic evidence gate before any model synthesis. It refuses to call a
 * traffic/conversion problem when the relevant denominator is unavailable.
 */
export async function generateGrowthDiagnosis(workspaceId: string): Promise<Diagnosis> {
  const supabase = createServiceClient()
  const [{ data: sources, error: sourceError }, { data: observations, error: obsError }] = await Promise.all([
    supabase.from('growth_sources').select('provider,status,last_success_at').eq('workspace_id', workspaceId),
    supabase.from('growth_observations').select('id,metric_key,metric_value,observed_at').eq('workspace_id', workspaceId).order('observed_at', { ascending: false }).limit(100),
  ])
  if (sourceError || obsError) throw new Error('growth_evidence_unavailable')

  const sourceRows = (sources ?? []) as Source[]
  const obsRows = (observations ?? []) as Observation[]
  const latest = new Map<string, Observation>()
  for (const row of obsRows) if (!latest.has(row.metric_key)) latest.set(row.metric_key, row)

  const missingSources = sourceRows.filter((s) => s.status !== 'connected').map((s) => s.provider)
  const bookings = latest.get('bookings.created')
  const confirmed = latest.get('bookings.confirmed')
  const sessions = latest.get('ga4.sessions')

  let diagnosis: Diagnosis
  if (!sessions || sessions.metric_value == null) {
    const evidence = [bookings, confirmed].filter(Boolean) as Observation[]
    diagnosis = {
      key: 'traffic_unmeasured',
      headline: 'Website demand cannot be diagnosed yet',
      explanation: `Caye has first-party booking evidence${bookings ? ` (${bookings.metric_value ?? 0} bookings in the latest window)` : ''}, but GA4 sessions are unavailable. That means it is not yet defensible to label the problem low traffic or poor website conversion.`,
      confidence: evidence.length ? 0.95 : 0.75,
      evidenceIds: evidence.map((e) => e.id),
      missingSources: Array.from(new Set(['ga4', ...missingSources])),
      freshness: evidence.length ? 'insufficient' : 'stale',
      recommendation: {
        title: 'Restore measurable acquisition data',
        rationale: 'Traffic and conversion require a real session denominator. Until GA4 is connected, Caye should optimize measurement before claiming an acquisition problem.',
        priority: 100,
        action: { type: 'connect_growth_source', provider: 'ga4', execution: 'requires_owner_setup' },
      },
    }
  } else {
    const bookingCount = bookings?.metric_value ?? null
    const conversion = bookingCount == null || sessions.metric_value <= 0 ? null : bookingCount / sessions.metric_value
    const evidence = [sessions, bookings, confirmed].filter(Boolean) as Observation[]
    diagnosis = {
      key: conversion == null ? 'funnel_incomplete' : conversion < 0.01 ? 'conversion_pressure' : 'measured_funnel',
      headline: conversion == null ? 'Traffic is measurable but the booking funnel is incomplete' : conversion < 0.01 ? 'Traffic is reaching the site but bookings are weak relative to sessions' : 'Traffic and bookings are both measurable',
      explanation: conversion == null ? 'GA4 sessions exist, but Caye cannot compute a defensible booking conversion rate from the available booking evidence.' : `Latest evidence shows ${sessions.metric_value} sessions and ${bookingCount} bookings, an observed booking-to-session ratio of ${(conversion * 100).toFixed(2)}%.`,
      confidence: conversion == null ? 0.7 : 0.9,
      evidenceIds: evidence.map((e) => e.id),
      missingSources,
      freshness: 'fresh',
      recommendation: {
        title: conversion != null && conversion < 0.01 ? 'Investigate booking-page conversion friction' : 'Segment acquisition before changing marketing',
        rationale: conversion != null && conversion < 0.01 ? 'Measured sessions are not turning into bookings at a healthy observed rate; inspect landing pages, booking exits, device mix, and source quality before spending more.' : 'A topline ratio alone does not identify which channels or landing pages create or destroy demand.',
        priority: 80,
        action: { type: 'analyze_growth_dimensions', execution: 'read_only' },
      },
    }
  }

  const now = new Date().toISOString()
  await supabase.from('growth_diagnoses').update({ superseded_at: now }).eq('workspace_id', workspaceId).is('superseded_at', null)
  const { data: inserted, error: diagnosisError } = await supabase.from('growth_diagnoses').insert({
    workspace_id: workspaceId,
    diagnosis_key: diagnosis.key,
    headline: diagnosis.headline,
    explanation: diagnosis.explanation,
    confidence: diagnosis.confidence,
    evidence_observation_ids: diagnosis.evidenceIds,
    missing_sources: diagnosis.missingSources,
    freshness: diagnosis.freshness,
    generated_at: now,
  }).select('id').single()
  if (diagnosisError || !inserted?.id) throw new Error('growth_diagnosis_write_failed')

  await supabase.from('growth_recommendations').insert({
    workspace_id: workspaceId,
    diagnosis_id: inserted.id,
    title: diagnosis.recommendation.title,
    rationale: diagnosis.recommendation.rationale,
    priority: diagnosis.recommendation.priority,
    recommended_action: diagnosis.recommendation.action,
    status: 'proposed',
  })

  return diagnosis
}
