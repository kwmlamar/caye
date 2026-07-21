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

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import {
  sendFreeFormWhatsApp,
  sendTemplateWhatsApp,
  type SendResult,
} from '@/lib/whatsapp/outbound'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { emailFallbackForFailedPing } from '@/lib/whatsapp/email-fallback'
import { resolveOperatorByPhone } from '@/lib/operator-identity'

// Kinds that represent Caye proactively messaging an operator about
// something (as opposed to system plumbing like otp/welcome/ack) — these
// get mirrored into caye_operator_messages so they show up in that
// operator's Caye Direct thread, not just as a WhatsApp they may or may
// not have noticed. Without this, a real escalation ping can go out over
// WhatsApp and never appear anywhere in the dashboard's conversation
// history, which reads as "Caye said she'd follow up but never did."
const OPERATOR_LOGGABLE_KINDS = new Set([
  'urgent_hold',
  'escalation',
  'escalation_followup',
  'same_day_booking',
  'morning_digest',
  'auth_failure',
])

const CONCURRENCY = 10
const RETRY_DELAY_MS = 5 * 60 * 1000
const UNREACHABLE_STREAK_THRESHOLD = 3

// Kinds that always require a template (the 24h window may be closed).
const TEMPLATE_REQUIRED_KINDS = new Set([
  'otp',
  'welcome',
  'morning_digest',
  'urgent_hold',
  'auth_failure',
  // Escalations may go to the founder, who has no 24h window with the
  // workspace's Caye number. Always template — match urgent_hold's shape.
  'escalation',
  'escalation_followup',
])

// Kinds where silence is dangerous → email fallback if WhatsApp fails.
const EMAIL_FALLBACK_KINDS = new Set(['urgent_hold', 'same_day_booking', 'auth_failure'])

// Kinds that bypass the operator mute.
const MUTE_BYPASS_KINDS = new Set(['auth_failure'])

interface QueueRow {
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

  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()

  const { data: rows, error } = await supabase
    .from('caye_outbound_queue')
    .select('id, workspace_id, kind, conversation_id, payload, scheduled_for, failure_count, idempotency_key')
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(100)

  if (error) {
    console.error('[outbound-worker] queue fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const summary = { scanned: rows?.length ?? 0, sent: 0, failed: 0, cancelled: 0, retried: 0 }
  if (!rows?.length) return NextResponse.json(summary)

  // Process with a small concurrency limit.
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map((row) => processRow(row)))
    for (const r of results) summary[r] = (summary[r] ?? 0) + 1
  }

  return NextResponse.json(summary)
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

  // Build & send.
  const { result: sendOutcome, phone } = await dispatch(row, config)
  return handleResult(row, config, sendOutcome, phone)
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

  const windowOpen = await isWhatsAppWindowOpen(row.workspace_id)
  const mustUseTemplate = TEMPLATE_REQUIRED_KINDS.has(row.kind) || !windowOpen

  if (mustUseTemplate) {
    const tmpl = templateForKind(row.kind, row.payload)
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

// Human-readable summary of a sent ping, for the caye_operator_messages
// audit log — this is what actually renders in Caye Direct's thread view,
// so it has to read like Caye talking, not a debug-log line. Every kind
// that needs the operator's attention closes with a concrete offer to
// take it off their hands — say the word and Caye runs with it, same
// yes/no confirmation flow as back-office chat. Purely informational kinds
// (same-day booking, digest) don't get a nudge — nothing to decide there.
function operatorPingLogBody(kind: string, payload: Record<string, unknown>): string {
  const str = (k: string, fallback = ''): string =>
    typeof payload[k] === 'string' ? (payload[k] as string) : fallback

  switch (kind) {
    case 'urgent_hold': {
      const who = str('contactName', 'A guest')
      const reason = str('reason', 'needs your call')
      return `${who} came in — ${reason}. Want me to take a first pass, or you got this one?`
    }
    case 'escalation': {
      const who = str('contactName', 'A guest')
      const summary = str('ping_summary') || str('internalContext', 'needs your call')
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
    case 'same_day_booking':
      return `Heads up — ${str('guest', 'A guest')} just booked for today.`
    case 'morning_digest': {
      const aging = str('agingEscalationsSummary')
      const agingLine = aging ? ` Oldest waiting: ${aging}` : ''
      return `${payload.heldCount ?? 0} threads holding for you, ${payload.bookingsTodayCount ?? 0} booked today.${agingLine} Want me to work through the held ones with you?`
    }
    case 'auth_failure':
      return `${str('service', 'A connected service')} needs reconnecting — I can't see new messages there until you do. Want me to walk you through it?`
    default:
      return `[${kind}]`
  }
}

async function logOperatorPing(workspaceId: string, phone: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  if (!OPERATOR_LOGGABLE_KINDS.has(kind)) return
  const supabase = createServiceClient()
  const operator = await resolveOperatorByPhone(supabase, workspaceId, phone)
  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'outbound',
    wa_message_id: null,
    body: operatorPingLogBody(kind, payload),
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
      .update({ status: 'sent', sent_at: now, updated_at: now })
      .eq('id', row.id)
    await supabase
      .from('workspace_ai_config')
      .update({
        whatsapp_failure_streak: 0,
        last_whatsapp_outbound_status: 'sent',
      })
      .eq('workspace_id', row.workspace_id)
    await logOperatorPing(row.workspace_id, phone, row.kind, row.payload)
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
    kind: row.kind as 'urgent_hold' | 'same_day_booking' | 'auth_failure',
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

function templateForKind(
  kind: string,
  payload: Record<string, unknown>
): { name: string; placeholders: string[] } | null {
  const str = (k: string, fallback = ''): string =>
    typeof payload[k] === 'string' ? (payload[k] as string) : fallback

  switch (kind) {
    case 'otp':
      return { name: 'caye_otp', placeholders: [str('code')] }
    case 'welcome':
      return { name: 'caye_welcome', placeholders: [str('firstName', 'there')] }
    case 'morning_digest': {
      // 4th placeholder holds the once-daily "still aging" escalation list
      // (see app/api/caye/morning-digest/route.ts's buildAgingEscalationsSummary
      // and decisions-log.md 2026-07-21) — a single pre-formatted string so
      // Meta's template stays a flat placeholder list, no conditionals.
      // Blank when there's nothing aging. Requires the caye_morning_digest
      // template to carry this 4th slot; falls back to just not showing
      // aging detail until that revision clears Meta review.
      const aging = str('agingEscalationsSummary')
      return {
        name: 'caye_morning_digest',
        placeholders: [
          str('firstName', 'there'),
          String(payload.heldCount ?? 0),
          String(payload.bookingsTodayCount ?? 0),
          aging ? ` Oldest waiting: ${aging}` : '',
        ],
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
    case 'same_day_booking':
      // No dedicated template in v1 — fall back to urgent_hold framing.
      return {
        name: 'caye_urgent_hold',
        placeholders: [str('guest', 'A guest'), 'booked for today'],
      }
    case 'escalation': {
      // Reuse the urgent_hold template. Prefer the operator-friendly
      // ping_summary supplied by the trigger; fall back to the older
      // "<category>: <internalContext>" shape only when ping_summary is
      // missing (legacy queue rows from before the field landed).
      const summary =
        str('ping_summary', '') ||
        `${str('category', 'policy')}: ${str('internalContext', 'needs your call').slice(0, 80)}`
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
    default:
      return null
  }
}

function freeFormBodyForKind(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'ack') {
    return typeof payload.body === 'string' ? (payload.body as string) : null
  }
  // All other kinds prefer their template; this is only used when the 24h
  // window is open AND the kind isn't in TEMPLATE_REQUIRED_KINDS. In v1
  // that's effectively ack only.
  return null
}
