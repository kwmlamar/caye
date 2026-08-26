/**
 * GET /api/caye/outbound-worker
 *
 * Cron tick (every ~30s) — drains caye_outbound_queue.
 *
 * For each pending row whose scheduled_for has passed:
 *   1. Re-check preconditions (workspace flag, mute state, conversation still held,
 *      operator not unreachable/blocked, race suppression).
 *   2. Pick free-form vs template based on the 24h window + the row's kind.
 *   3. Send via Meta Cloud API (lib/whatsapp/outbound.ts).
 *   4. On success: mark sent, reset failure streak.
 *   5. On transient failure (first time): re-schedule +5 min.
 *      On second failure: mark failed, increment streak, trigger email fallback
 *      for urgent kinds, set whatsapp_unreachable if streak ≥ 3.
 *   6. On block-specific error: mark dead_letter, set whatsapp_blocked.
 *
 * Secured by CRON_SECRET via x-cron-secret header.
 */

import { after, NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import {
  sendFreeFormWhatsApp,
  sendTemplateWhatsApp,
  type SendResult,
} from '@/lib/whatsapp/outbound'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { emailFallbackForFailedPing } from '@/lib/whatsapp/email-fallback'
import { resolveOperatorByPhone } from '@/lib/operator-identity'
import { loadScheduleConfig, nextDigestTime, localDayOfWeek } from '@/lib/whatsapp/schedule'
import { recordCronRun, checkStaleCronsAndAlert } from '@/lib/cron-run-log'
import { alertFounderOfDeliveryFailure } from '@/lib/whatsapp/founder-alert'
import { sendFounderAlertEmail } from '@/lib/email/founder-mailer'
import { extractErrorCode } from '@/lib/whatsapp/delivery-errors'
import { resyncTemplatesAfterParamMismatch } from '@/lib/whatsapp/template-sync'
import { detectInternalLeak } from '@/lib/operator-text-guard'
import { drainPendingOperationsSafely } from '@/lib/pending-operations-worker'
import { markAttentionNotified, fingerprint, SUBJECT_CONVERSATION } from '@/lib/owner-attention'
import { decideOperatorNotification } from '@/lib/whatsapp/operator-notification-gate'
import { bookingStateLabel } from '@/lib/whatsapp/triggers'

// Kinds that represent Caye proactively messaging an operator about
// something (as opposed to system plumbing like otp/welcome/ack) — these
// get mirrored into caye_operator_messages so they show up in that
// operator's Caye Direct thread, not just as a WhatsApp they may or may
// not have noticed. Without this, a real escalation ping can go out over
// WhatsApp and never appear anywhere in the dashboard's conversation
// history, which reads as "Caye said she'd follow up but never did."
export const OPERATOR_LOGGABLE_KINDS = new Set([
  'urgent_hold',
  'escalation',
  'escalation_followup',
  'booking_created',
  'morning_digest',
  'auth_failure',
  // Scan-crons' operator-facing findings (real content as of 2026-08-13 —
  // see the note on TEMPLATE_REQUIRED_KINDS below). Logged here so a sent
  // one shows up in Caye Direct with a real delivery status, distinct from
  // the reasoning-transcript row persistAgentTurns already wrote (queued/
  // suppressed rows get 'not_sent'/no row here at all).
  'opportunity_scan',
  'business_insights',
  // Operator-set reminders (schedule_reminder). Logged so a reminder that
  // can't go out free-form — the 24h window closed since she set it — still
  // lands somewhere she'll see it, rather than silently failing. There is no
  // approved template for reminders and inventing one would need Meta review.
  'operator_reminder',
  'dropped_confirmation',
  'reply_review',
])

const CONCURRENCY = 10
const RETRY_DELAY_MS = 5 * 60 * 1000
export const UNREACHABLE_STREAK_THRESHOLD = 3

// Kinds that always require a template (the 24h window may be closed).
const TEMPLATE_REQUIRED_KINDS = new Set([
  'otp',
  'welcome',
  'morning_digest',
  'urgent_hold',
  'auth_failure',
  // No dedicated template yet (reuses caye_urgent_hold) and no free-form
  // body composer either — always template so a booking ping can never
  // hard-fail with "no free-form body" just because the window happened
  // to be open.
  'booking_created',
  // 'opportunity_scan'/'business_insights' deliberately NOT here as of
  // 2026-08-13 (were here before). They used to be unconditionally
  // template-required because the enqueuing cron only ever wrote a row on
  // its window-closed branch, with no free-form composer for the kind at
  // all — so the template was the ONLY path, and it could never carry real
  // content ("check Caye Direct"). Both crons now enqueue unconditionally
  // (real finding text in payload.freeFormBody either way) and let dispatch()
  // pick per-recipient window state at actual send time, same as
  // 'escalation' below — so forcing a template here would silently regress
  // back to content-free pings whenever the window happened to be open.
  //
  // 'escalation' deliberately NOT here (2026-08-07, was here before). It
  // used to be forced to a template unconditionally because escalations
  // may route to the founder, who has no 24h window with the workspace's
  // Caye number — but that penalized the OWNER's rich free-form brief
  // (lib/operator-brief.ts) every time, even with an open window, just to
  // cover a founder recipient who has none. dispatch() already resolves
  // window-openness per recipient phone (payload.to_phone, one queue row
  // per recipient) and falls through to the template automatically when
  // that specific phone's window is closed — so the founder case still
  // gets the template on its own, without penalizing the owner.
  //
  // 'escalation_followup' stays template-required — its only remaining
  // sender is the founder backstop (maybeEscalateToFounder), which never
  // has an open window with the workspace's Caye number.
  'escalation_followup',
])

// Kinds where silence is dangerous → email fallback if WhatsApp fails.
export const EMAIL_FALLBACK_KINDS = new Set(['urgent_hold', 'booking_created', 'auth_failure'])

// Kinds that bypass the operator mute.
const MUTE_BYPASS_KINDS = new Set(['auth_failure'])

export interface QueueRow {
  id: string
  workspace_id: string
  kind: string
  conversation_id: string | null
  payload: Record<string, unknown>
  scheduled_for: string
  failure_count: number
  idempotency_key: string | null
}

interface WorkspaceConfig {
  workspace_id: string
  whatsapp_outbound_enabled: boolean
  operator_whatsapp_number: string | null
  operator_whatsapp_verified_at: string | null
  whatsapp_muted_until: string | null
  whatsapp_unreachable: boolean
  whatsapp_blocked: boolean
  whatsapp_failure_streak: number
  /** Receptionist-spec Q4 — hard kill on all operator pings. Defaults
   *  true for new workspaces; explicit flip to false once loop validated. */
  notifications_paused: boolean
  /** Receptionist-spec Q4 — when set, all pings route here instead of
   *  operator_whatsapp_number. Canonical operator number stays unchanged. */
  operator_notification_override_phone: string | null
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    // Accept Vercel cron's Authorization: Bearer header OR legacy
    // x-cron-secret header (for manual/external triggers).
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // Fire on every authenticated tick (the common case is an empty queue,
  // which is exactly when this needs to still run) — see cron-run-log.ts
  // for why this lives here rather than as its own cron.
  await checkStaleCronsAndAlert()
  await checkStaleDeliveryAndAlert()
  await checkDeliveryHealthAndAlert()
  await checkOrphanedOperatorMessagesAndAlert()

  // Drain the external-effects outbox on the same tick (2026-08-11). Same
  // reasoning as checkStaleCronsAndAlert living here rather than in its own
  // job: a queue whose only drain is a cron someone has to remember to
  // register externally is a queue that silently stops — which is exactly
  // what happened to this very endpoint for ~25h on 2026-07-25. Never throws.
  after(drainPendingOperationsSafely())

  try {
    const summary = await recordCronRun('outbound-worker', async () => {
      const supabase = createServiceClient()
      const nowIso = new Date().toISOString()

      const { data: rows, error } = await supabase
        .from('caye_outbound_queue')
        .select('id, workspace_id, kind, conversation_id, payload, scheduled_for, failure_count, idempotency_key')
        .eq('status', 'pending')
        .lte('scheduled_for', nowIso)
        .order('scheduled_for', { ascending: true })
        .limit(100)

      if (error) throw new Error(error.message)

      const summary = { scanned: rows?.length ?? 0, sent: 0, failed: 0, cancelled: 0, retried: 0 }
      if (!rows?.length) return summary

      // Process with a small concurrency limit.
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const slice = rows.slice(i, i + CONCURRENCY)
        const results = await Promise.all(slice.map((row) => processRow(row)))
        for (const r of results) summary[r] = (summary[r] ?? 0) + 1
      }

      return summary
    })
    return NextResponse.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[outbound-worker] queue fetch failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Meta normally posts a 'sent' status callback within seconds of accepting
// a message — that first callback is Meta's own acknowledgment, not device
// delivery, so 15 minutes of total silence past send means something is
// actually wrong (a dropped webhook, a genuinely undelivered message), not
// just a slow network. Rows in this state stay marked status='sent' with
// wa_delivery_status still null forever unless something checks for them —
// this is the other half of "never permanently 'sent'" alongside the
// dispatch-time and async-status-webhook alert paths below.
const DELIVERY_GRACE_MINUTES = 15

/**
 * Sweep for operator-bound sends Meta accepted but never followed up on
 * with any delivery-status callback. Marks them with a synthetic
 * wa_delivery_status='timeout' (distinct from Meta's real sent/delivered/
 * read/failed values) so a later tick doesn't re-check or re-alert on the
 * same row. Best-effort — never throws, matches checkStaleCronsAndAlert's
 * shape.
 */
async function checkStaleDeliveryAndAlert(): Promise<void> {
  try {
    const supabase = createServiceClient()
    const cutoff = new Date(Date.now() - DELIVERY_GRACE_MINUTES * 60 * 1000).toISOString()
    const { data: rows } = await supabase
      .from('caye_outbound_queue')
      .select('id, workspace_id, kind, sent_at')
      .eq('status', 'sent')
      .is('wa_delivery_status', null)
      .lt('sent_at', cutoff)
      .in('kind', Array.from(OPERATOR_LOGGABLE_KINDS))
      .limit(50)

    for (const row of rows ?? []) {
      // Checking this error matters: caye_outbound_queue_wa_delivery_status_check
      // rejected 'timeout' as a value for weeks of would-be fixes before this
      // check existed (confirmed live 2026-07-26) — the update silently no-
      // opped every tick, so rows never left the `wa_delivery_status IS NULL`
      // pool, and the same backlog got rescanned and re-alerted (once per
      // hour, per the alert's own dedup) forever instead of once ever.
      const { error: markErr } = await supabase
        .from('caye_outbound_queue')
        .update({ wa_delivery_status: 'timeout', wa_delivery_status_at: new Date().toISOString() })
        .eq('id', row.id)
      if (markErr) {
        console.error(`[outbound-worker] failed to mark ${row.id} as timeout:`, markErr)
        continue // don't alert for a row we couldn't actually retire — avoids the same forever-loop
      }

      await alertFounderOfDeliveryFailure({
        workspaceId: row.workspace_id,
        kind: row.kind,
        detail: `No delivery confirmation from Meta after ${DELIVERY_GRACE_MINUTES}min`,
        stage: 'delivery',
      })
    }
  } catch (err) {
    console.error('[outbound-worker] stale-delivery check failed:', err)
  }
}

// send_operator_message (lib/caye-agent/tools/write-low/send-operator-
// message.ts) claims a caye_outbound_queue row and resolves it (sent/
// failed/deleted) synchronously, inline, within the same request — normal
// completion is milliseconds. It also pushes scheduled_for an hour out
// purely so THIS cron's normal `scheduled_for <= now` poll can never race
// that synchronous dispatch. A row still status='pending' this long after
// being CREATED (not scheduled_for — created_at) can only mean the process
// that claimed it died before resolving it; no legitimate call takes
// anywhere close to this long.
const OPERATOR_MESSAGE_ORPHAN_GRACE_MINUTES = 5

/**
 * Sweep for send_operator_message rows orphaned by a mid-flight crash.
 *
 * WHY THIS NEVER RE-DISPATCHES (2026-08-16 hardening)
 * The crash could have happened either BEFORE or AFTER Meta actually
 * accepted the message — there is no way to tell from this row alone, and
 * Meta does not expose an idempotent-send API keyed on our
 * idempotency_key/biz_opaque_callback_data (that field is opaque tracking
 * data echoed back in webhooks, not a dedup key Meta enforces — see
 * alertFounderOfDeliveryFailure's doc comment). Re-dispatching an orphan
 * therefore risks a REAL duplicate WhatsApp to a real operator exactly
 * where confirm-pending-action.ts's own stated bias already applies: "a
 * missed retry is recoverable by hand; a duplicate send is not." So this
 * always dead-letters and alerts a human instead of guessing — same
 * failure-closed choice, same reasoning, different call site.
 *
 * Deliberately does NOT add 'operator_message' to freeFormBodyForKind /
 * templateForKind / OPERATOR_LOGGABLE_KINDS — this kind is never meant to
 * reach dispatch() at all; the main poll loop above only ever sees one of
 * these rows if scheduled_for's full hour has *also* elapsed, and by then
 * this sweep (running every tick, 5 min grace) has already dead-lettered
 * it, so dispatch() never gets the chance.
 */
export async function checkOrphanedOperatorMessagesAndAlert(): Promise<void> {
  try {
    const supabase = createServiceClient()
    const staleCutoff = new Date(Date.now() - OPERATOR_MESSAGE_ORPHAN_GRACE_MINUTES * 60 * 1000).toISOString()
    const { data: rows } = await supabase
      .from('caye_outbound_queue')
      .select('id, workspace_id, payload')
      .eq('kind', 'operator_message')
      .eq('status', 'pending')
      .lt('created_at', staleCutoff)
      .limit(20)

    for (const row of rows ?? []) {
      const payload = row.payload as { operator_name?: string; to_phone?: string } | null
      const who = payload?.operator_name ?? payload?.to_phone ?? 'an operator'
      const detail = `orphaned send_operator_message to ${who} — process crashed mid-dispatch, delivery outcome unknown, not retried to avoid a possible duplicate send`

      const { error: markErr } = await supabase
        .from('caye_outbound_queue')
        .update({ status: 'dead_letter', last_error: detail })
        .eq('id', row.id)
      if (markErr) {
        console.error(`[outbound-worker] failed to dead-letter orphaned operator_message ${row.id}:`, markErr)
        continue // don't alert for a row we couldn't actually retire — avoids re-alerting forever
      }

      await alertFounderOfDeliveryFailure({
        workspaceId: row.workspace_id,
        kind: 'operator_message',
        detail,
        stage: 'dispatch',
      })
    }
  } catch (err) {
    console.error('[outbound-worker] orphaned-operator-message check failed:', err)
  }
}

const HEALTH_CHECK_LOOKBACK_HOURS = 48

/**
 * Backstop, independent of any single failure/alert path above: a workspace
 * whose operator pings are *individually* alerting fine (or not alerting
 * at all, if some future bug reintroduces a gap like the one this whole
 * file's alerting was built to close) can still go dark for days without
 * anyone noticing the pattern — "no news" silently read as "fine" for 14
 * days before this was caught. Confirmed live 2026-07-27: 93 operator
 * pings, zero confirmed deliveries, over 2 weeks. See
 * briefs/whatsapp-delivery-reliability.md.
 *
 * Runs on every tick (cheap query) but only actually alerts once/day per
 * workspace via the same dedup table the other alert paths use.
 */
async function checkDeliveryHealthAndAlert(): Promise<void> {
  try {
    const supabase = createServiceClient()

    const { data: configs } = await supabase
      .from('workspace_ai_config')
      .select('workspace_id')
      .eq('whatsapp_outbound_enabled', true)
    if (!configs?.length) return
    const workspaceIds = configs.map((c) => c.workspace_id as string)

    const cutoff = new Date(Date.now() - HEALTH_CHECK_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
    const { data: sends } = await supabase
      .from('caye_outbound_queue')
      .select('workspace_id, wa_delivery_status')
      .eq('status', 'sent')
      .gte('sent_at', cutoff)
      .in('workspace_id', workspaceIds)
      .in('kind', Array.from(OPERATOR_LOGGABLE_KINDS))
    if (!sends?.length) return

    const byWorkspace = new Map<string, { sent: number; confirmed: number }>()
    for (const s of sends) {
      const entry = byWorkspace.get(s.workspace_id as string) ?? { sent: 0, confirmed: 0 }
      entry.sent += 1
      if (s.wa_delivery_status === 'delivered' || s.wa_delivery_status === 'read') entry.confirmed += 1
      byWorkspace.set(s.workspace_id as string, entry)
    }

    const day = new Date().toISOString().slice(0, 10)

    for (const [workspaceId, counts] of byWorkspace) {
      if (counts.confirmed > 0) continue // has at least one proof of life

      const alertKey = `wa-health-silent-${workspaceId}-${day}`
      const { error: dedupErr } = await supabase
        .from('caye_founder_alert_log')
        .insert({ alert_key: alertKey })
      if (dedupErr) {
        if (dedupErr.code === '23505') continue // already alerted today
        console.error('[outbound-worker] health-check dedup failed:', dedupErr)
        continue
      }

      const { data: customer } = await supabase
        .from('customers')
        .select('business_name')
        .eq('id', workspaceId)
        .maybeSingle()
      const business = (customer?.business_name as string | null) ?? workspaceId

      const { data: emailSetting } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'founder_email')
        .maybeSingle()
      const founderEmail = emailSetting?.value as string | undefined
      if (founderEmail) {
        await sendFounderAlertEmail({
          to: founderEmail,
          subject: `Caye: ${business}'s WhatsApp channel has zero confirmed deliveries in ${HEALTH_CHECK_LOOKBACK_HOURS}h`,
          body:
            `${business} sent ${counts.sent} operator ping(s) over the last ${HEALTH_CHECK_LOOKBACK_HOURS}h ` +
            `and Meta never confirmed delivery on any of them. Not necessarily an outright failure — ` +
            `could be stuck in 'timeout' or genuinely undelivered. Worth checking the dashboard.`,
        })
      } else {
        console.error(`[outbound-worker] silent-channel alert for ${business} but no founder_email configured`)
      }
    }
  } catch (err) {
    console.error('[outbound-worker] delivery-health check failed:', err)
  }
}

type RowOutcome = 'sent' | 'failed' | 'cancelled' | 'retried'

async function processRow(row: QueueRow): Promise<RowOutcome> {
  const supabase = createServiceClient()

  const { data: config, error: configErr } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, whatsapp_outbound_enabled, operator_whatsapp_number, operator_whatsapp_verified_at, whatsapp_muted_until, whatsapp_unreachable, whatsapp_blocked, whatsapp_failure_streak, notifications_paused, operator_notification_override_phone')
    .eq('workspace_id', row.workspace_id)
    .maybeSingle<WorkspaceConfig>()

  if (configErr || !config) {
    return cancel(row, `workspace_ai_config missing: ${configErr?.message ?? 'no row'}`)
  }

  // Defense in depth — enqueueOutbound already gates on this, but a row
  // queued before pause was flipped on could still be sitting here. Skip
  // it cleanly rather than firing.
  if (config.notifications_paused) return cancel(row, 'notifications_paused')

  // Precondition: feature flag on, operator verified, not blocked / unreachable.
  if (!config.whatsapp_outbound_enabled) return cancel(row, 'flag off')
  if (!config.operator_whatsapp_number || !config.operator_whatsapp_verified_at) {
    return cancel(row, 'operator number not verified')
  }
  if (config.whatsapp_blocked) return cancel(row, 'whatsapp_blocked')
  if (config.whatsapp_unreachable && !EMAIL_FALLBACK_KINDS.has(row.kind)) {
    return cancel(row, 'whatsapp_unreachable')
  }

  // Mute (auth_failure bypasses).
  if (
    config.whatsapp_muted_until &&
    new Date(config.whatsapp_muted_until).getTime() > Date.now() &&
    !MUTE_BYPASS_KINDS.has(row.kind)
  ) {
    // Defer past the mute window rather than cancelling.
    await supabase
      .from('caye_outbound_queue')
      .update({ scheduled_for: config.whatsapp_muted_until, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    return 'retried'
  }

  // digest_days may have been narrowed (Settings card) after this row was
  // already queued for a day that's since been disabled — defensive
  // re-check, same reschedule-not-cancel shape as the mute check above.
  // The common case (digest_days unchanged since enqueue) never hits this,
  // since nextDigestTime already skips disabled days at enqueue time.
  if (row.kind === 'morning_digest') {
    const schedCfg = await loadScheduleConfig(row.workspace_id)
    const now = new Date()
    if (!schedCfg.digestDays.includes(localDayOfWeek(now, schedCfg.timezone))) {
      await supabase
        .from('caye_outbound_queue')
        .update({ scheduled_for: nextDigestTime(now, schedCfg).toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id)
      return 'retried'
    }
  }

  // For urgent_hold rows, confirm the conversation is still held.
  if (row.kind === 'urgent_hold' && row.conversation_id) {
    const { data: conv } = await supabase
      .from('unified_conversations')
      .select('human_agent_enabled')
      .eq('id', row.conversation_id)
      .maybeSingle()
    if (!conv?.human_agent_enabled) {
      return cancel(row, 'conversation resolved before send')
    }

    // Race-aware suppression: operator may have replied directly through their
    // own channel after we queued. Detect by looking for any outbound automated=false
    // message on the conversation since the row was created.
    if (await operatorRepliedDirectly(row)) {
      return cancel(row, 'operator handled directly')
    }
  }

  // Re-check booking_created rows at actual dispatch time, not just enqueue
  // time (2026-08-26, Autumn McNeill incident). enqueueBookingCreated
  // already checks operator awareness once, but quiet-hours deferral can
  // put hours between that decision and this dispatch — a stale-worker
  // race the enqueue-time check alone can't see. Same structural evidence,
  // asked again right before the send actually goes out. Applies equally
  // to a row enqueued for a LATER material state (PR #135 review) — the
  // check re-fetches the booking fresh and re-derives conversationId from
  // it, so it's not tied to which "generation" of queue row this is.
  if (row.kind === 'booking_created') {
    const cancelReason = await bookingCreatedDispatchCancelReason(row)
    if (cancelReason) return cancel(row, cancelReason)
  }

  // Build & send.
  const { result: sendOutcome, phone } = await dispatch(row, config)
  return handleResult(row, config, sendOutcome, phone)
}

/**
 * What, if anything, should cancel a booking_created row right before it
 * dispatches — the booking having since been cancelled, its payload text
 * having gone stale (the booking's real state moved on since this row was
 * queued), or the operator having since handled the linked conversation
 * directly. Returns the cancel() reason string, or null to proceed with
 * the send. Pulled out of processRow as its own function so it's
 * independently testable without mocking every other precondition
 * processRow checks first.
 */
export async function bookingCreatedDispatchCancelReason(row: QueueRow): Promise<string | null> {
  const bookingId = typeof row.payload.bookingId === 'string' ? row.payload.bookingId : null
  if (!bookingId) return null

  const supabase = createServiceClient()
  const { data: booking } = await supabase
    .from('bookings')
    .select(
      'customer_name, status, payment_confirmed_at, payment_link_sent_at, cancelled_at, booking_date, booking_time, number_of_people, conversation_id'
    )
    .eq('id', bookingId)
    .maybeSingle()
  if (!booking || booking.status === 'cancelled') {
    return 'booking cancelled before send'
  }

  // Same fields enqueueBookingCreated fingerprints — kept identical so the
  // two hashes are directly comparable.
  const fingerprintParts = [
    booking.status,
    booking.payment_confirmed_at,
    booking.payment_link_sent_at,
    booking.cancelled_at,
    booking.booking_date,
    booking.booking_time,
    booking.number_of_people,
  ]
  const currentFp = fingerprint(fingerprintParts)
  const queuedFp = typeof row.payload.stateFingerprint === 'string' ? (row.payload.stateFingerprint as string) : null

  // A row whose payload no longer matches the booking's CURRENT state is
  // stale (PR #135 review, third finding + adversarial question): its
  // guest/summary/stateLabel text describes a state that has since moved
  // on — e.g. queued while pending, confirmed-and-paid before the
  // quiet-hours-deferred send actually fired. The worker must never send
  // text describing an older state than what's now authoritative. Cancel
  // outright rather than silently rewriting the row in place — a fresh
  // notification for the NEW state, if one is ever warranted, is a fresh
  // enqueueBookingCreated call's job (it will get its own fresh
  // idempotency key), not something this dispatch-time safety check
  // should try to produce itself. Rows enqueued before payload carried
  // stateFingerprint (queuedFp === null) skip this check rather than being
  // treated as unconditionally stale.
  if (queuedFp !== null && queuedFp !== currentFp) {
    return 'booking state changed before send'
  }

  const conversationId = booking.conversation_id ?? row.conversation_id

  // Re-runs the SAME owner-attention gate enqueueBookingCreated used
  // (PR #135 review, third and fourth findings) — not just the operator-
  // participation check, and not treated as authoritative only when it
  // says SUPPRESS_OPERATOR_AWARE. At dispatch time the gate is the single
  // authority on whether this notification is STILL warranted at all: the
  // enqueue-time decision can go stale exactly like the payload text can
  // (another producer may have told the operator about this same state in
  // the meantime, the attention item may have been resolved, a cooldown
  // may now apply) — every one of those is a fresh SUPPRESS_*/
  // RESOLVED_NO_NOTIFICATION outcome the worker must respect, not just the
  // operator-awareness case. Only the gate has access to
  // caye_owner_attention.first_state_fingerprint to pick the correct
  // participation-evidence mode, so re-deriving any of this from raw
  // booking fields here would duplicate logic that can drift out of sync.
  const decision = await decideOperatorNotification({
    workspaceId: row.workspace_id,
    subjectType: 'booking',
    subjectId: bookingId,
    conversationId,
    title: `${booking.customer_name ?? 'A guest'} — ${bookingStateLabel(booking.status, booking.payment_confirmed_at)}`,
    priority: 'awareness',
    fingerprintParts,
    blockedOnOperator: false,
    resolvableAutonomously: false,
    ...(conversationId ? { operatorParticipationCheck: { conversationId } } : {}),
  })

  switch (decision.outcome) {
    case 'SEND_NEW':
    case 'SEND_REMINDER':
    case 'SEND_CRITICAL_ESCALATION':
      return null
    case 'SUPPRESS_OPERATOR_AWARE':
      return 'operator handled directly'
    case 'SUPPRESS_NO_CHANGE':
      return 'operator already informed / no material change'
    case 'SUPPRESS_RECENTLY_NOTIFIED':
      return 'notification no longer warranted'
    case 'RESOLVED_NO_NOTIFICATION':
      return 'attention item resolved'
  }
}

async function dispatch(row: QueueRow, config: WorkspaceConfig): Promise<{ result: SendResult; phone: string }> {
  // Escalation rows pre-resolve the destination phone in payload.to_phone
  // (one row per recipient — owner uses the override-aware lookup; founder
  // uses operator_allowlist directly). All other kinds keep the existing
  // override-aware lookup against the canonical operator number.
  const payloadPhone =
    typeof row.payload.to_phone === 'string' ? (row.payload.to_phone as string) : null
  const phone =
    payloadPhone ??
    config.operator_notification_override_phone ??
    config.operator_whatsapp_number!
  const idem = row.idempotency_key ?? `queue-${row.id}`

  const windowOpen = await isWhatsAppWindowOpen(row.workspace_id, phone)

  // morning_digest prefers the narrative briefing over the flat count
  // template whenever the window's open — TEMPLATE_REQUIRED_KINDS keeps
  // 'morning_digest' listed (below) so the closed-window case still falls
  // straight through to the template, same as before this branch existed.
  // Also falls through to template when composition failed at enqueue time
  // (freeFormBodyForKind returns null) rather than hard-failing the send.
  if (row.kind === 'morning_digest' && windowOpen) {
    const narrativeBody = freeFormBodyForKind(row.kind, row.payload)
    if (narrativeBody) {
      return { result: await sendFreeFormWhatsApp(phone, narrativeBody, idem), phone }
    }
  }

  const mustUseTemplate = TEMPLATE_REQUIRED_KINDS.has(row.kind) || !windowOpen

  if (mustUseTemplate) {
    const tmpl = await templateForKind(row.kind, row.payload)
    if (!tmpl) {
      return { result: { status: 'failed', error: `no template mapped for kind=${row.kind}`, transient: false }, phone }
    }
    return { result: await sendTemplateWhatsApp(phone, tmpl.name, tmpl.placeholders, idem), phone }
  }

  const body = freeFormBodyForKind(row.kind, row.payload)
  if (!body) {
    return { result: { status: 'failed', error: `no free-form body for kind=${row.kind}`, transient: false }, phone }
  }
  return { result: await sendFreeFormWhatsApp(phone, body, idem), phone }
}

/**
 * Last line of defence on the legacy `internalContext` fallbacks below.
 *
 * Those only fire for queue rows predating brief/one_line/ping_summary, but
 * `internalContext` is machine-composed on the forced-escalation path
 * ("Forced escalation — b2b_partnership (inbound classifier — …)") and both
 * call sites feed operator-facing surfaces — one a Caye Direct bubble, one a
 * WhatsApp template placeholder. Neither is recallable once sent, so a leak
 * degrades to the generic fallback rather than shipping the payload.
 */
function operatorSafe(text: string, fallback: string): string {
  if (!text.trim()) return fallback
  const leak = detectInternalLeak(text)
  if (!leak) return text
  console.error(`[outbound-worker] internal text in operator ping (${leak}) — using fallback`)
  return fallback
}

// Human-readable summary of a sent ping, for the caye_operator_messages
// audit log — this is what actually renders in Caye Direct's thread view,
// so it has to read like Caye talking, not a debug-log line. Every kind
// that needs the operator's attention closes with a concrete offer to
// take it off their hands — say the word and Caye runs with it, same
// yes/no confirmation flow as back-office chat. Purely informational kinds
// (same-day booking, digest) don't get a nudge — nothing to decide there.
//
// DERIVES FROM THE SEND, DOESN'T RE-IMPLEMENT IT (2026-08-12). This used to
// be a switch that ran in parallel with freeFormBodyForKind, and the two
// drifted: `operator_reminder` had a case there (so WhatsApp got real text)
// and none here, so it fell through to `default: return "[" + kind + "]"`
// and put the literal string "[operator_reminder]" in Mrs. Max's Caye Direct
// thread. `dropped_confirmation` had the identical hole. Mirroring the
// free-form body FIRST closes the whole class rather than the two instances
// — any kind that composes a real body at enqueue time now shows that exact
// body, which is also what the escalation/morning_digest cases below were
// hand-rolling. The switch is now only the template-fallback path: what to
// say when the operator got a canned template instead of composed prose.
export function operatorPingLogBody(kind: string, payload: Record<string, unknown>): string {
  const composed = freeFormBodyForKind(kind, payload)
  if (composed?.trim()) return operatorSafe(composed, fallbackPingLogBody(kind, payload))
  return operatorSafe(fallbackPingLogBody(kind, payload), NEUTRAL_PING_LOG_BODY)
}

/**
 * What the thread shows when the operator received a TEMPLATE rather than
 * composed prose — the window was closed, or composition failed at enqueue
 * time. Mirrors the template's meaning in Caye's voice.
 */
function fallbackPingLogBody(kind: string, payload: Record<string, unknown>): string {
  const str = (k: string, fallback = ''): string =>
    typeof payload[k] === 'string' ? (payload[k] as string) : fallback

  switch (kind) {
    case 'urgent_hold': {
      const who = str('contactName', 'A guest')
      const reason = str('reason', 'needs your call')
      return `${who} came in — ${reason}. Want me to take a first pass, or you got this one?`
    }
    case 'escalation': {
      // NO `if (payload.brief) return payload.brief` here. The composed
      // brief is already mirrored by operatorPingLogBody above, which runs
      // it through operatorSafe first. Re-reading the same field here made
      // this branch the leak's escape hatch: a brief carrying machinery got
      // rejected by operatorSafe, fell through to this fallback, and this
      // fallback handed the identical string straight back. Caught by
      // ping-log-body.test.ts. A fallback must never reconstruct the thing
      // it is a fallback FOR.
      const who = str('contactName', 'A guest')
      const summary =
        str('ping_summary') || operatorSafe(str('internalContext'), 'needs your call')
      return `Kicking this one up to you — ${who}: ${summary}. Tell me what to say and I'll send it, or handle it yourself and I'll stand down.`
    }
    case 'escalation_followup': {
      // Owner-facing follow-up pings were folded into morning_digest
      // (2026-07-21) — the only sender left for this kind is the founder
      // backstop (maybeEscalateToFounder in lib/whatsapp/escalation-followup.ts),
      // so `who`/`summary` here always describe an operator-hasn't-acted
      // situation read by the founder, not the owner.
      const who = str('contactName', 'A guest')
      const summary = str('ping_summary') || `${str('category', 'policy')} escalation`
      return `Still sitting on this one — ${who} has been waiting a while now: ${summary}. Say the word and I'll send a holding reply, or let me know you've got it.`
    }
    case 'booking_created':
      // stateLabel is grounded in the booking's real status/payment fields
      // (lib/whatsapp/triggers.ts's bookingStateLabel) — never "Just
      // booked" for a booking nobody has paid for yet. A pending booking is
      // a lead, not a completed sale; a genuinely confirmed/paid one says
      // so honestly. 'New pending booking' is the fallback for queue rows
      // enqueued before this field existed.
      return `${str('stateLabel', 'New pending booking')} — ${str('guest', 'A guest')}, ${str('summary', 'details in the dashboard')}.`
    case 'morning_digest': {
      // Same as 'escalation' above — the narrative body is mirrored by
      // operatorPingLogBody, guarded. This branch is only the count-based
      // line for when the template was what actually went out (closed
      // window, or composition failed at enqueue time).
      const aging = str('agingEscalationsSummary')
      const agingLine = aging ? ` Oldest waiting: ${aging}` : ''
      return `${payload.heldCount ?? 0} threads holding for you, ${payload.bookingsTodayCount ?? 0} booked today.${agingLine} Want me to work through the held ones with you?`
    }
    case 'auth_failure':
      return `${str('service', 'A connected service')} needs reconnecting — I can't see new messages there until you do. Want me to walk you through it?`
    // This used to point at Caye Direct ("the full write-up is in Caye
    // Direct; say the word..."), which was also literally false on WhatsApp
    // outside the window (2026-08-09) AND told an operator who only ever
    // uses WhatsApp to go open a dashboard she doesn't use (2026-08-13 —
    // operators here are WhatsApp-only by design, see repo CLAUDE.md).
    // freeFormBodyForKind now composes/mirrors the real finding text for
    // this kind, so this branch is only reached if composition genuinely
    // produced nothing — say something true and content-free instead of
    // naming a surface the operator was never meant to visit.
    case 'opportunity_scan':
      return `Noticed something during my rounds worth a look — I'll bring it up next time we talk.`
    case 'business_insights':
      return `This week's business insights are ready — ask me and I'll walk you through them.`
    case 'reply_review':
      return `I sent ${str('contactName', 'a guest')} a reply and would like you to review it when you have a moment.`
    default:
      // NEVER echo the kind. An unmapped kind reaching an operator-facing
      // surface is a bug in this file, and the old `[${kind}]` turned that
      // bug into a system token sitting in a paying customer's message
      // thread. Degrade to something a human would say and shout in the
      // logs, where the diagnostic actually belongs.
      console.error(
        `[outbound-worker] no operator-facing log body for kind=${kind} — using neutral fallback. Add a case to fallbackPingLogBody.`
      )
      return NEUTRAL_PING_LOG_BODY
  }
}

/**
 * Last-resort operator-facing text. Says something true (a ping went out)
 * without inventing urgency we can't substantiate for an unmapped kind.
 */
const NEUTRAL_PING_LOG_BODY = `Sent you a heads-up just now — ask me and I'll pull up the details.`

/**
 * Ping kinds that mean "the owner has now been told about a specific item",
 * so the attention ledger's notified stamp should move. urgent_hold belongs
 * here as much as escalation does — it is the same conversation reaching the
 * same owner, just via the other trigger path.
 */
const ATTENTION_NOTIFYING_KINDS = new Set([
  'escalation',
  'escalation_followup',
  'urgent_hold',
  // 2026-08-13: opportunity-scan/business-insights now enqueue through this
  // same worker (see the note on TEMPLATE_REQUIRED_KINDS above) and their
  // subject identity lives in payload.attentionSubjectType/Id, not
  // conversationId/escalationId — see the generalized lookup below.
  'opportunity_scan',
  'business_insights',
])

async function logOperatorPing(
  workspaceId: string,
  phone: string,
  kind: string,
  conversationId: string | null,
  payload: Record<string, unknown>,
  messageId: string | null,
  queueId: string
): Promise<void> {
  if (!OPERATOR_LOGGABLE_KINDS.has(kind)) return
  const supabase = createServiceClient()
  const operator = await resolveOperatorByPhone(supabase, workspaceId, phone)
  const logBody = operatorPingLogBody(kind, payload)

  // Stamp the shared attention ledger with what the owner was just told
  // (2026-08-12). This is the write that stops the morning digest from
  // announcing "nothing needs your attention" half an hour after this ping
  // said otherwise — the digest reads notified_fingerprint to tell news from
  // repetition. Best-effort; a bookkeeping failure must not fail the send
  // that already happened.
  //
  // Subject identity: prefer payload.attentionSubjectType/Id when the
  // producer set them explicitly (opportunity-scan/business-insights key by
  // a content hash, not a conversation — see those crons and
  // operator-notification-gate.ts). Otherwise fall back to the original
  // conversation-or-escalation-id scheme: conversation to match
  // SUBJECT_CONVERSATION (lib/owner-attention.ts) — the ledger row for an
  // escalated thread is the THREAD's row, the same one owner-attention-sync
  // maintains from the held queue — with escalation id as the fallback for
  // a conversation-less escalation, mirroring escalation.ts.
  if (ATTENTION_NOTIFYING_KINDS.has(kind)) {
    const explicitSubjectType =
      typeof payload.attentionSubjectType === 'string' ? payload.attentionSubjectType : null
    const explicitSubjectId =
      typeof payload.attentionSubjectId === 'string' ? payload.attentionSubjectId : null
    const escalationId = typeof payload.escalationId === 'string' ? payload.escalationId : null
    const subjectType = explicitSubjectType ?? (conversationId ? SUBJECT_CONVERSATION : 'escalation')
    const subjectId = explicitSubjectId ?? conversationId ?? escalationId
    if (subjectId) {
      await markAttentionNotified({
        workspaceId,
        subjectType,
        subjectId,
        summary: logBody,
        queueId,
      })
    }
  }

  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'outbound',
    // Only ever called from the 'sent' branch of handleResult below, so this
    // is always a successful dispatch — 'sent' for now, refined to
    // delivered/read/failed by handleDeliveryStatus once Meta's status
    // webhook arrives, matched by this same wa_message_id.
    wa_message_id: messageId,
    wa_delivery_status: 'sent',
    wa_delivery_error: null,
    body: logBody,
    intent: null,
    operator_allowlist_id: operator?.id ?? null,
    operator_name: operator?.name ?? null,
    operator_role: operator?.role ?? null,
  })
}

async function handleResult(
  row: QueueRow,
  config: WorkspaceConfig,
  result: SendResult,
  phone: string
): Promise<RowOutcome> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  if (result.status === 'sent') {
    await supabase
      .from('caye_outbound_queue')
      .update({ status: 'sent', sent_at: now, wa_message_id: result.messageId, updated_at: now })
      .eq('id', row.id)
    await supabase
      .from('workspace_ai_config')
      .update({
        whatsapp_failure_streak: 0,
        last_whatsapp_outbound_status: 'sent',
      })
      .eq('workspace_id', row.workspace_id)
    await logOperatorPing(row.workspace_id, phone, row.kind, row.conversation_id, row.payload, result.messageId, row.id)
    return 'sent'
  }

  // Blocked → terminal, mark workspace blocked.
  if (result.blocked) {
    await supabase
      .from('caye_outbound_queue')
      .update({
        status: 'dead_letter',
        last_error: result.error,
        failure_count: row.failure_count + 1,
        updated_at: now,
      })
      .eq('id', row.id)
    await supabase
      .from('workspace_ai_config')
      .update({ whatsapp_blocked: true, last_whatsapp_outbound_status: 'blocked' })
      .eq('workspace_id', row.workspace_id)
    if (EMAIL_FALLBACK_KINDS.has(row.kind)) await fireFallback(row)
    if (OPERATOR_LOGGABLE_KINDS.has(row.kind)) {
      await alertFounderOfDeliveryFailure({
        workspaceId: row.workspace_id,
        kind: row.kind,
        detail: result.error,
        stage: 'dispatch',
      })
    }
    return 'failed'
  }

  // Transient + first attempt → retry once after 5 min.
  if (result.transient && row.failure_count < 1) {
    await supabase
      .from('caye_outbound_queue')
      .update({
        failure_count: row.failure_count + 1,
        last_error: result.error,
        scheduled_for: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        updated_at: now,
      })
      .eq('id', row.id)
    return 'retried'
  }

  // Otherwise: mark failed, bump streak, possibly flip unreachable, fire fallback.
  const newStreak = config.whatsapp_failure_streak + 1
  await supabase
    .from('caye_outbound_queue')
    .update({
      status: 'failed',
      failure_count: row.failure_count + 1,
      last_error: result.error,
      updated_at: now,
    })
    .eq('id', row.id)
  await supabase
    .from('workspace_ai_config')
    .update({
      whatsapp_failure_streak: newStreak,
      whatsapp_unreachable: newStreak >= UNREACHABLE_STREAK_THRESHOLD,
      last_whatsapp_outbound_status: 'failed',
    })
    .eq('workspace_id', row.workspace_id)

  if (EMAIL_FALLBACK_KINDS.has(row.kind)) await fireFallback(row)

  // A 132xxx means Meta's template no longer matches what whatsapp_templates
  // says it is — almost always a template edited in WhatsApp Manager without
  // the table being updated. Resync so the next attempt sends the right
  // param count instead of failing identically forever (caye_morning_digest
  // did exactly that for a week; see lib/whatsapp/template-sync.ts).
  const failureCode = extractErrorCode(result.error)
  if (failureCode != null && failureCode >= 132000 && failureCode < 133000) {
    resyncTemplatesAfterParamMismatch(`${row.kind} dispatch error ${failureCode}`)
  }

  // Confirmed live 2026-07-23: without this, a permanently-failed row (the
  // morning_digest template-param mismatch) sat silent for 3 days — nobody
  // alerted, nothing retried, surfaced only when Karenda separately
  // reported missing WhatsApp messages. This is the fix for that.
  if (OPERATOR_LOGGABLE_KINDS.has(row.kind)) {
    await alertFounderOfDeliveryFailure({
      workspaceId: row.workspace_id,
      kind: row.kind,
      detail: result.error,
      stage: 'dispatch',
    })
  }
  return 'failed'
}

async function cancel(row: QueueRow, reason: string): Promise<RowOutcome> {
  const supabase = createServiceClient()
  await supabase
    .from('caye_outbound_queue')
    .update({
      status: 'cancelled',
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
  return 'cancelled'
}

async function fireFallback(row: QueueRow): Promise<void> {
  if (!EMAIL_FALLBACK_KINDS.has(row.kind)) return
  await emailFallbackForFailedPing({
    workspaceId: row.workspace_id,
    kind: row.kind as 'urgent_hold' | 'booking_created' | 'auth_failure',
    payload: row.payload,
  })
}

async function operatorRepliedDirectly(row: QueueRow): Promise<boolean> {
  if (!row.conversation_id) return false
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('unified_messages')
    .select('id, metadata, direction, created_at')
    .eq('conversation_id', row.conversation_id)
    .eq('direction', 'outbound')
    .gt('created_at', row.scheduled_for)
    .limit(5)

  if (!data?.length) return false
  // Anything outbound that wasn't auto-generated by Caye counts as an operator reply.
  return data.some((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>
    return meta.is_automated !== true && meta.generated_by !== 'caye'
  })
}

// ---------------------------------------------------------------------------
// Template + free-form body composers (kept in-route until Phase 3 expands them)
// ---------------------------------------------------------------------------

// caye_morning_digest is a live, already-approved template — the
// 4-placeholder revision (decisions-log.md 2026-07-21) is only safe to send
// once Meta has actually approved it. Sending 4 params against a template
// Meta still recognizes with 3 would get rejected by the Cloud API,
// breaking the previously-working held-count/bookings digest, not just
// the new aging detail. Checked at send time (not cached) so the moment
// the follow-up migration flips status back to 'approved' post-review,
// sends pick it up with no further deploy.
async function morningDigestSupports4Placeholders(): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('whatsapp_templates')
    .select('status, placeholder_count')
    .eq('name', 'caye_morning_digest')
    .maybeSingle()
  return data?.status === 'approved' && (data?.placeholder_count ?? 0) >= 4
}

async function templateForKind(
  kind: string,
  payload: Record<string, unknown>
): Promise<{ name: string; placeholders: string[] } | null> {
  const str = (k: string, fallback = ''): string =>
    typeof payload[k] === 'string' ? (payload[k] as string) : fallback

  switch (kind) {
    case 'otp':
      return { name: 'caye_otp', placeholders: [str('code')] }
    case 'welcome':
      return { name: 'caye_welcome', placeholders: [str('firstName', 'there')] }
    case 'morning_digest': {
      const base = [str('firstName', 'there'), String(payload.heldCount ?? 0), String(payload.bookingsTodayCount ?? 0)]
      const supports4 = await morningDigestSupports4Placeholders()
      if (!supports4) {
        return { name: 'caye_morning_digest', placeholders: base }
      }
      // 4th placeholder holds the once-daily "still aging" escalation list
      // (see app/api/caye/morning-digest/route.ts's buildAgingEscalationsSummary)
      // — a single pre-formatted string so Meta's template stays a flat
      // placeholder list, no conditionals. Blank when there's nothing aging.
      const aging = str('agingEscalationsSummary')
      return {
        name: 'caye_morning_digest',
        placeholders: [...base, aging ? ` Oldest waiting: ${aging}` : ''],
      }
    }
    case 'urgent_hold':
      return {
        name: 'caye_urgent_hold',
        placeholders: [str('contactName', 'A guest'), str('reason', 'needs your call')],
      }
    case 'auth_failure':
      return {
        name: 'caye_auth_failure',
        placeholders: [str('service', 'a connected service'), str('reconnectUrl', '')],
      }
    case 'booking_created':
      // No dedicated template in v1 — reuse urgent_hold's two-placeholder
      // shape. stateLabel carries the real status (see fallbackPingLogBody's
      // matching comment) — the default here is 'new booking', not 'just
      // booked', for the same reason.
      return {
        name: 'caye_urgent_hold',
        placeholders: [str('guest', 'A guest'), `${str('stateLabel', 'New booking')} — ${str('summary', 'details in the dashboard')}`],
      }
    case 'escalation': {
      // Reuse the urgent_hold template — only reached when the window's
      // closed for this recipient (see TEMPLATE_REQUIRED_KINDS's comment;
      // 'escalation' is no longer unconditionally template-required).
      // Prefer one_line (buildOperatorBrief's template-safe summary —
      // newline-free, real ellipsis, and for a form submission actually
      // names the booking instead of dumping raw field syntax), then the
      // older ping_summary, then the oldest "<category>: <internalContext>"
      // shape for legacy queue rows predating both fields.
      const summary =
        str('one_line', '') ||
        str('ping_summary', '') ||
        `${str('category', 'policy')}: ${operatorSafe(str('internalContext'), 'needs your call').slice(0, 80)}`
      return {
        name: 'caye_urgent_hold',
        placeholders: [str('contactName', 'A guest'), summary],
      }
    }
    case 'escalation_followup': {
      // Only sender left for this kind is the founder backstop (see
      // operatorPingLogBody's escalation_followup case above).
      const baseSummary =
        str('ping_summary', '') ||
        `${str('category', 'policy')} escalation`
      return {
        name: 'caye_urgent_hold',
        placeholders: [str('contactName', 'A guest'), `still waiting — ${baseSummary}`],
      }
    }
    // No dedicated template (same "reuse caye_urgent_hold" fallback as
    // booking_created/escalation above). Used to be a content-free "check
    // Caye Direct" pointer whenever the window was closed at send time —
    // removed 2026-08-13: operators here are WhatsApp-only by design (see
    // repo CLAUDE.md) and are never expected to open a dashboard. Now
    // carries the actual finding, truncated to fit a template placeholder —
    // same real text freeFormBodyForKind sends when the window's open, just
    // shorter. If composition genuinely produced nothing (shouldn't happen —
    // the enqueuing cron only gets here with real text), falls back to a
    // truthful, contentless "something worth a look" rather than inventing
    // detail or naming the dashboard.
    case 'opportunity_scan': {
      const finding = str('freeFormBody')
      return {
        name: 'caye_urgent_hold',
        placeholders: ['Caye', finding ? truncateForTemplate(finding) : 'noticed something during her rounds worth a look'],
      }
    }
    case 'business_insights': {
      const insight = str('freeFormBody')
      return {
        name: 'caye_urgent_hold',
        placeholders: ['Caye', insight ? truncateForTemplate(insight) : "has this week's business insights ready"],
      }
    }
    case 'reply_review': {
      const body = str('body')
      return {
        name: 'caye_urgent_hold',
        placeholders: ['Caye', body ? truncateForTemplate(body) : 'sent a reply worth reviewing'],
      }
    }
    default:
      return null
  }
}

function freeFormBodyForKind(kind: string, payload: Record<string, unknown>): string | null {
  // Composed at enqueue time by schedule_reminder (formatReminderBody), so
  // the text she gets is the text she asked for, decorated once.
  if (kind === 'operator_reminder') {
    return typeof payload.body === 'string' && payload.body.trim() ? (payload.body as string) : null
  }
  // Composed at enqueue time by the dropped-confirmation sweep
  // (formatDroppedConfirmation), for the same reason as operator_reminder:
  // the recipient's local time is baked into the sentence.
  if (kind === 'dropped_confirmation') {
    return typeof payload.body === 'string' && payload.body.trim() ? (payload.body as string) : null
  }
  if (kind === 'reply_review') {
    return typeof payload.body === 'string' && payload.body.trim() ? (payload.body as string) : null
  }
  if (kind === 'ack') {
    return typeof payload.body === 'string' ? (payload.body as string) : null
  }
  // morning_digest's narrative body (lib/caye-agent/briefing.ts's
  // composeMorningBriefing, composed at enqueue time in morning-digest's
  // cron) — the richer LLM-composed briefing, preferred over the flat
  // count template whenever the 24h window is open. Absent when
  // composition failed at enqueue time; dispatch() falls back to the
  // template in that case.
  if (kind === 'morning_digest') {
    return typeof payload.narrativeBody === 'string' && payload.narrativeBody.trim()
      ? (payload.narrativeBody as string)
      : null
  }
  // The composed operator brief (lib/operator-brief.ts) — multi-line, so it
  // can only go out free-form; Meta rejects newlines in template params.
  // Absent only for escalation rows enqueued before this landed, or if
  // recordEscalation's compose step failed — dispatch() falls back to the
  // template (one_line/ping_summary placeholder) in that case, same
  // fallback shape as morning_digest above.
  if (kind === 'escalation') {
    return typeof payload.brief === 'string' && payload.brief.trim()
      ? (payload.brief as string)
      : null
  }
  // The scan crons' real finding/insight text (2026-08-13) — composed at
  // enqueue time by the agent turn itself, same idiom as escalation's
  // brief above. This is what lets the window-open path carry the actual
  // content instead of falling through to templateForKind's truncated
  // version; both now read from the same payload.freeFormBody field.
  if (kind === 'opportunity_scan' || kind === 'business_insights') {
    return typeof payload.freeFormBody === 'string' && payload.freeFormBody.trim()
      ? (payload.freeFormBody as string)
      : null
  }
  // All other kinds prefer their template; this is only used when the 24h
  // window is open AND the kind isn't in TEMPLATE_REQUIRED_KINDS. In v1
  // that's ack + morning_digest's narrative path + escalation's brief +
  // the scan crons' free-form finding.
  return null
}

// Meta template placeholders read poorly past a sentence or two on a phone
// lock screen, and unlike the free-form path there's no length ceremony —
// just cut cleanly at a word boundary with an ellipsis. The full text is
// always what actually reaches the operator when the window's open; this
// only shortens the closed-window fallback.
function truncateForTemplate(text: string, maxLen = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen).replace(/\s+\S*$/, '')}…`
}
