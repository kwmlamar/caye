import 'server-only'
import { createServiceClient } from './supabase-server'
import { sendFreeFormWhatsApp } from './whatsapp/outbound'
import { recordBounceKillSwitchPause } from './outreach-pause-control'
import type { BounceSeverity } from './sender-classifier'

/**
 * Reactive deliverability protection for autonomous cold outreach
 * (decisions-log 2026-08-12) — catches whatever the preventive layer
 * (lib/outreach-send-limits.ts's daily cap) lets through. Bounce detection
 * is a proxy (lib/sender-classifier.ts's isBounceNotification /
 * classifyBounceSeverity, body-pattern matching), not a true bounce API —
 * Zoho Mail doesn't expose one. No complaint-rate signal exists at all;
 * documented as a known gap, not silently promised as covered.
 *
 * Called from app/api/email/poll/route.ts whenever a newly-ingested inbound
 * message to the internal_sales workspace classifies as a bounce.
 *
 * 2026-09-03: hardened after the 2026-08-24 trip (5 bounces in 24h, the
 * default threshold, stopped ALL cold sending; founder resumed manually
 * 2026-08-27). Every bounce used to weigh the same regardless of severity,
 * so an out-of-quota mailbox counted exactly as much as a dead domain. The
 * trip decision is now a weighted score, not a raw count: a hard bounce
 * (address confirmed dead) is the real reputation signal and weighs 1; a
 * soft bounce (mailbox full, greylisted, deferred) is mostly noise and
 * weighs a fraction of that. `unknown` (bounce detected but body didn't
 * classify) stays weighted like hard — conservative on purpose, since it
 * covers both a genuinely ambiguous new bounce and every pre-2026-09-03
 * historical row, and there is no way to prove either was harmless.
 */
const HARD_BOUNCE_WEIGHT = 1
const SOFT_BOUNCE_WEIGHT = 0.25
const UNKNOWN_BOUNCE_WEIGHT = 1

function bounceWeight(classification: string | null): number {
  if (classification === 'soft') return SOFT_BOUNCE_WEIGHT
  if (classification === 'hard') return HARD_BOUNCE_WEIGHT
  return UNKNOWN_BOUNCE_WEIGHT // null (legacy row) or 'unknown'
}

/**
 * Pure threshold check, extracted so it's unit-testable without a Supabase
 * double — same pattern as lib/nudge-eligibility.ts's decideOutreachLeadAction.
 * Takes the already-weighted score (see bounceWeight above), not a raw
 * count — the (number, number) -> boolean contract is unchanged, only what
 * the caller feeds it changed.
 */
export function shouldTripKillSwitch(weightedBounceScoreInWindow: number, threshold: number): boolean {
  return weightedBounceScoreInWindow >= threshold
}

/**
 * Bounce rate (bounces / sends in the same window) at which the trailing
 * window stops looking like normal cold-email attrition and starts looking
 * like a list-quality or reputation problem.
 *
 * Calibrated against real production data, not a rule of thumb: over
 * 2026-08-14..2026-08-30 the workspace sent 341 outreach messages and took
 * 25 bounces — a 7.3% baseline. 15% is roughly 2x that baseline, so normal
 * weeks pass and a genuine deterioration trips.
 */
export const OUTREACH_BOUNCE_RATE_THRESHOLD = 0.15

/**
 * Volume-normalized trip decision.
 *
 * WHY THIS EXISTS: the absolute weighted threshold alone is only meaningful
 * at a fixed send volume, and this system's volume is about to change by an
 * order of magnitude. The default threshold of 5-in-24h was set when the
 * pipeline was sending ~20/day, where 5 bounces means a 25% rate — a real
 * emergency. At the restored 50 first-touches/day target (plus follow-ups,
 * so ~100-150 sends/day), 5 bounces is a ~4% rate, i.e. BETTER than the
 * measured 7.3% baseline. A count-only rule would therefore trip every
 * single day the moment supply is fixed, halting all cold outreach on a
 * completely healthy list. That is a foreseeable self-inflicted outage, not
 * a safety feature.
 *
 * So a trip now requires BOTH:
 *   1. the weighted score to clear the absolute floor (unchanged — this is
 *      what stops 2-bounces-out-of-3-sends from being ignored at low
 *      volume), AND
 *   2. the bounce rate over the same window to clear
 *      OUTREACH_BOUNCE_RATE_THRESHOLD.
 *
 * This is deliberately NOT a blanket relaxation: at low volume the rate
 * check is trivially satisfied and behavior is identical to before. It only
 * changes the high-volume case, which is exactly the case the count-only
 * rule got wrong. When the send count is unknown or zero (telemetry gap),
 * it falls back to the absolute check alone — failing toward tripping.
 */
export function shouldTripKillSwitchForWindow(args: {
  weightedBounceScore: number
  threshold: number
  sendsInWindow: number | null
}): { trip: boolean; rate: number | null } {
  const { weightedBounceScore, threshold, sendsInWindow } = args
  if (!shouldTripKillSwitch(weightedBounceScore, threshold)) return { trip: false, rate: null }
  if (sendsInWindow === null || sendsInWindow <= 0) return { trip: true, rate: null }
  const rate = weightedBounceScore / sendsInWindow
  return { trip: rate >= OUTREACH_BOUNCE_RATE_THRESHOLD, rate }
}

export interface BounceRecordDetail {
  classification: BounceSeverity
  /** Lowercased failed-recipient address, or null when it couldn't be
   *  confirmed — stored as NULL, never a guess. */
  recipient: string | null
  /** Subject of the bounce email, for later audit of a misclassification. */
  sourceSubject: string | null
}

/**
 * Logs one bounce and trips outreach_autosend_paused if the trailing-
 * window's severity-weighted score crosses the workspace's configured
 * threshold. Safe to call once per actually-new bounce email — each call
 * inserts a row, so callers must not call this more than once for the same
 * message (the poll route only calls it at message-creation time, not on
 * re-reads of an already-ingested message).
 */
export async function recordBounceAndMaybeTrip(
  workspaceId: string,
  detail: BounceRecordDetail
): Promise<void> {
  const supabase = createServiceClient()

  const { error: insertError } = await supabase.from('caye_outreach_bounces').insert({
    workspace_id: workspaceId,
    bounced_recipient: detail.recipient,
    classification: detail.classification,
    source_subject: detail.sourceSubject?.slice(0, 500) ?? null,
  })
  if (insertError) {
    // Detail columns (migration 20260903110000_outreach_bounce_detail_
    // suppression.sql) not deployed yet — fall back to the pre-2026-09-03
    // bare-row insert so bounce counting keeps working at all rather than
    // silently dropping every bounce until the migration lands.
    console.warn(
      '[outreach-kill-switch] detail insert failed, falling back to bare row (migration not deployed?):',
      insertError.message
    )
    await supabase.from('caye_outreach_bounces').insert({ workspace_id: workspaceId })
  }

  const { data: aiConfig } = await supabase
    .from('workspace_ai_config')
    .select('outreach_autosend_paused, outreach_bounce_threshold, outreach_bounce_window_hours')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  // No config row yet, or already paused — nothing left to trip.
  if (!aiConfig || aiConfig.outreach_autosend_paused) return

  const threshold = aiConfig.outreach_bounce_threshold ?? 5
  const windowHours = aiConfig.outreach_bounce_window_hours ?? 24
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  const windowRows = await windowBounceRows(supabase, workspaceId, cutoff)
  const hardCount = windowRows.filter((r) => r.classification === 'hard').length
  const softCount = windowRows.filter((r) => r.classification === 'soft').length
  const unknownCount = windowRows.length - hardCount - softCount
  const weightedScore = windowRows.reduce((sum, r) => sum + bounceWeight(r.classification), 0)

  const sendsInWindow = await countOutreachSendsInWindow(supabase, workspaceId, cutoff)
  const verdict = shouldTripKillSwitchForWindow({ weightedBounceScore: weightedScore, threshold, sendsInWindow })
  if (!verdict.trip) return

  const ratePart = verdict.rate === null
    ? 'send volume for the window was unavailable, so the rate check was skipped'
    : `${(verdict.rate * 100).toFixed(1)}% of ${sendsInWindow} sends, over the ` +
      `${(OUTREACH_BOUNCE_RATE_THRESHOLD * 100).toFixed(0)}% rate threshold`
  const reason =
    `${windowRows.length} bounces in the trailing ${windowHours} hours ` +
    `(${hardCount} hard, ${softCount} soft, ${unknownCount} unclassified; ` +
    `weighted score ${weightedScore.toFixed(2)}) crossed the safety threshold of ${threshold} — ${ratePart}.`

  await recordBounceKillSwitchPause(workspaceId, reason)

  console.warn(
    `[outreach-kill-switch] tripped for workspace ${workspaceId}: ${reason}`
  )

  await pageFounderOutreachPaused(windowRows.length, windowHours)
}

/**
 * Outreach sends in the same trailing window, for the rate denominator.
 * Mirrors lib/outreach-send-limits.ts's countOutreachSendsToday, but over
 * an arbitrary cutoff rather than start-of-day. Counts first touches and
 * follow-ups together, because both are cold sends to non-opted-in
 * addresses and both can bounce.
 *
 * Returns null (not 0) when the count can't be read, so the caller can tell
 * "no sends" apart from "don't know" and fail toward tripping rather than
 * silently disabling the kill switch on a query error.
 */
async function countOutreachSendsInWindow(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  cutoff: string
): Promise<number | null> {
  try {
    const [firstTouch, followups] = await Promise.all([
      supabase.from('outreach_leads').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).gte('first_touch_sent_at', cutoff),
      supabase.from('outreach_leads').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).gte('last_nudge_at', cutoff),
    ])
    if (firstTouch.error || followups.error) return null
    return (firstTouch.count ?? 0) + (followups.count ?? 0)
  } catch {
    return null
  }
}

/**
 * Trailing-window bounce rows for the weighted-score calculation. Reads
 * `classification` when it exists; if it doesn't (migration not deployed
 * yet), falls back to the pre-2026-09-03 raw count so the kill switch
 * degrades to its old unweighted-count behavior instead of going silently
 * blind (an empty `windowRows` would mean "no bounces ever trip it").
 */
async function windowBounceRows(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  cutoff: string
): Promise<{ classification: string | null }[]> {
  const { data, error } = await supabase
    .from('caye_outreach_bounces')
    .select('classification')
    .eq('workspace_id', workspaceId)
    .gte('created_at', cutoff)

  if (!error) return data ?? []

  console.warn(
    '[outreach-kill-switch] classification column unavailable, falling back to raw count (migration not deployed?):',
    error.message
  )
  const { count } = await supabase
    .from('caye_outreach_bounces')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', cutoff)
  return Array.from({ length: count ?? 0 }, () => ({ classification: null as string | null }))
}

/**
 * Direct-send page to the founder, bypassing the outbound queue and the
 * morning digest — same pattern as lib/cron-run-log.ts's
 * alertFounderOfStaleCrons. A kill-switch trip is exactly the "worth
 * breaking cadence for" case the daily-digest reporting design (decisions-
 * log 2026-08-12) called out as the one exception to "everything else is a
 * daily rollup."
 */
async function pageFounderOutreachPaused(bounceCount: number, windowHours: number): Promise<void> {
  const supabase = createServiceClient()
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'founder_phone')
    .maybeSingle()

  const founderPhone = setting?.value as string | undefined
  if (!founderPhone) {
    console.error('[outreach-kill-switch] tripped but no founder_phone configured to page')
    return
  }

  const result = await sendFreeFormWhatsApp(
    founderPhone,
    `⚠️ Outreach paused: ${bounceCount} bounces in the last ${windowHours}h crossed the threshold. ` +
    `Cold sending stopped automatically — replies to warm leads still work. Check the dashboard when you can.`,
    `outreach-kill-switch-${Math.floor(Date.now() / (60 * 60 * 1000))}`
  )
  if (result.status === 'failed') {
    console.error('[outreach-kill-switch] founder page send failed:', result.error)
  }
}
