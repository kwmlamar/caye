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

const STALE_AFTER_MS = 72 * 60 * 60 * 1000

function evidenceFreshness(rows: Observation[]): 'fresh' | 'stale' | 'insufficient' {
  if (!rows.length) return 'insufficient'
  const newest = Math.max(...rows.map((row) => Date.parse(row.observed_at)).filter(Number.isFinite))
  if (!Number.isFinite(newest)) return 'insufficient'
  return Date.now() - newest > STALE_AFTER_MS ? 'stale' : 'fresh'
}

/**
 * Deterministic evidence gate before any model synthesis. It refuses to call a
 * traffic/conversion problem when the relevant denominator or attribution is unavailable.
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
      explanation: `Caye has first-party booking evidence${bookings ? ` (${bookings.metric_value ?? 0} bookings created in the latest window)` : ''}, but GA4 sessions are unavailable. That means it is not yet defensible to label the problem low traffic or poor website conversion.`,
      confidence: evidence.length ? 0.95 : 0.75,
      evidenceIds: evidence.map((e) => e.id),
      missingSources: Array.from(new Set(['ga4', ...missingSources])),
      freshness: evidenceFreshness(evidence) === 'fresh' ? 'insufficient' : evidenceFreshness(evidence),
      recommendation: {
        title: 'Restore measurable acquisition data',
        rationale: 'Traffic analysis requires a real session denominator. Until GA4 is connected, Caye should fix measurement before claiming an acquisition problem.',
        priority: 100,
        action: { type: 'connect_growth_source', provider: 'ga4', execution: 'requires_owner_setup' },
      },
    }
  } else {
    const bookingCount = bookings?.metric_value ?? null
    const evidence = [sessions, bookings, confirmed].filter(Boolean) as Observation[]
    const freshness = evidenceFreshness(evidence)

    if (sessions.metric_value === 0) {
      diagnosis = {
        key: 'zero_sessions_observed',
        headline: 'GA4 observed zero sessions in the latest window',
        explanation: bookings && (bookings.metric_value ?? 0) > 0
          ? `GA4 reports zero sessions while Caye recorded ${bookings.metric_value} bookings created in the same general analysis window. This is evidence of a measurement or attribution mismatch, not proof that the website had no demand.`
          : 'GA4 reports zero sessions. Caye should verify tracking and the reporting window before treating this as proof of zero demand.',
        confidence: 0.95,
        evidenceIds: evidence.map((e) => e.id),
        missingSources,
        freshness,
        recommendation: {
          title: 'Verify GA4 collection before changing marketing',
          rationale: 'A zero-session reading should be validated against tracking configuration and first-party activity before Caye changes acquisition strategy.',
          priority: 95,
          action: { type: 'verify_growth_measurement', provider: 'ga4', execution: 'read_only' },
        },
      }
    } else {
      const ratio = bookingCount == null ? null : bookingCount / sessions.metric_value
      diagnosis = {
        key: bookingCount == null ? 'funnel_incomplete' : 'measured_funnel',
        headline: bookingCount == null ? 'Traffic is measurable but first-party booking evidence is incomplete' : 'Traffic and bookings are both measurable',
        explanation: ratio == null
          ? 'GA4 sessions exist, but Caye cannot compare them with first-party booking volume from the available evidence.'
          : `Latest evidence shows ${sessions.metric_value} sessions and ${bookingCount} bookings created, an observed booking-to-session ratio of ${(ratio * 100).toFixed(2)}%. Because Caye bookings are not yet website-attributed, this ratio is context only and is not a website conversion rate.`,
        confidence: ratio == null ? 0.7 : 0.9,
        evidenceIds: evidence.map((e) => e.id),
        missingSources,
        freshness,
        recommendation: {
          title: 'Segment acquisition and attribution before changing marketing',
          rationale: 'Topline sessions and total bookings cannot identify which channels, landing pages, or booking paths create demand. Caye should collect dimensions and attribution evidence before diagnosing conversion friction.',
          priority: 80,
          action: { type: 'analyze_growth_dimensions', execution: 'read_only' },
        },
      }
    }
  }

  const now = new Date().toISOString()
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

  const { error: supersedeError } = await supabase
    .from('growth_diagnoses')
    .update({ superseded_at: now })
    .eq('workspace_id', workspaceId)
    .is('superseded_at', null)
    .neq('id', inserted.id)
  if (supersedeError) throw new Error('growth_diagnosis_supersede_failed')

  const { error: recommendationError } = await supabase.from('growth_recommendations').insert({
    workspace_id: workspaceId,
    diagnosis_id: inserted.id,
    title: diagnosis.recommendation.title,
    rationale: diagnosis.recommendation.rationale,
    priority: diagnosis.recommendation.priority,
    recommended_action: diagnosis.recommendation.action,
    status: 'proposed',
  })
  if (recommendationError) throw new Error('growth_recommendation_write_failed')

  return diagnosis
}
