import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getOutreachOperationalStatus, type OutreachOperationalStatus } from '@/lib/outreach-operational-status'
import { businessLocalDate } from '@/lib/booking-time'

const DEFAULT_WORKSPACE_TIMEZONE = 'America/Nassau'

export interface AuthoritativeOwnerOperationalState {
  capturedAt: string
  workspace: {
    id: string
    name: string
    timezone: string
    localDate: string
    localTime: string
  }
  outreach: OutreachOperationalStatus | null
}

/**
 * Deterministic gate for owner questions that require a fresh outreach read
 * before the model reasons. Routing identity + business-local clock are now
 * always loaded; this function only decides whether the heavier outreach
 * subsystem snapshot is needed for the current owner question.
 */
export function needsAuthoritativeOwnerOperationalState(message: string): boolean {
  const text = message.trim().toLowerCase()
  if (!text) return false
  return /\b(outreach|autosend|auto-send|lead(?:s)?|draft(?:s)?|email(?:s|ing)?|send(?:s|ing)?|sourcing|pipeline|funnel|bottleneck)\b/.test(text) ||
    /\b(what(?:'s| is) going on|what have you done|what(?:'s| is) working|what isn(?:'t| not) working|what should i (?:know|pay attention to)|what are you (?:working on|currently working on)|anything (?:i should know|you need from me)|what can you handle|what requires me|if i disappeared|run(?:ning)? the business)\b/.test(text)
}

function businessLocalTime(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now)
}

export async function loadAuthoritativeOwnerOperationalState(
  workspaceId: string,
  message: string
): Promise<AuthoritativeOwnerOperationalState> {
  const supabase = createServiceClient()
  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, full_name, timezone')
    .eq('id', workspaceId)
    .maybeSingle()

  const timezone = (customer?.timezone as string | null) || DEFAULT_WORKSPACE_TIMEZONE
  const workspaceName =
    ((customer?.business_name as string | null) || (customer?.full_name as string | null) || workspaceId).trim()
  const now = new Date()

  return {
    capturedAt: now.toISOString(),
    workspace: {
      id: workspaceId,
      name: workspaceName,
      timezone,
      localDate: businessLocalDate(timezone, now),
      localTime: businessLocalTime(timezone, now),
    },
    outreach: needsAuthoritativeOwnerOperationalState(message)
      ? await getOutreachOperationalStatus(workspaceId)
      : null,
  }
}

/**
 * Render machine-derived routing/time/provenance constraints on EVERY owner
 * turn. Outreach facts are appended only when that subsystem was requested.
 */
export function renderAuthoritativeOwnerOperationalState(
  state: AuthoritativeOwnerOperationalState | null
): string | null {
  if (!state) return null

  const lines = [
    'AUTHORITATIVE OWNER STATE — SYSTEM OF RECORD, READ BEFORE REASONING',
    `- Snapshot captured: ${state.capturedAt}`,
    '',
    'CURRENT WORKSPACE — AUTHORITATIVE ROUTING STATE',
    `- workspace_id: ${state.workspace.id}`,
    `- workspace_name: ${state.workspace.name}`,
    `- workspace_timezone: ${state.workspace.timezone}`,
    `- business_local_date: ${state.workspace.localDate}`,
    `- business_local_time: ${state.workspace.localTime}`,
    '- This routed workspace identity is authoritative for THIS turn. Conversation history, prior workspace context, summaries, and model memory cannot override it.',
    '- Never claim the user switched to another workspace merely because an older message/history mentions one. A switch is real only when the deterministic routing layer supplies a different workspace on a later turn.',
    '- If history conflicts with workspace_id/workspace_name above, treat the history as stale and continue using the routed workspace above.',
    '',
    'PROVENANCE + TIME CLAIM CONSTRAINTS — DETERMINISTIC',
    '- A synced message with sender_type=business proves only that the BUSINESS sent it. It does NOT prove that Caye sent it.',
    '- You may say "I sent it" / "I emailed them" only when a tool or audit record explicitly attributes that exact outbound to Caye or a Caye execution. Missing/null/unknown sender attribution must remain unknown; never upgrade it to Caye.',
    '- If an outbound is known only as business-originated, say "the business sent it" or explain that the actor is not proven. Do not take credit for it.',
    '- business_local_date and business_local_time above are the authoritative current clock for this workspace. Never use the device/server/UTC clock or conversation timestamps as a substitute.',
    '- A booking being relative_to_today=today NEVER proves it is "happening now". Without deterministic in-progress evidence, describe it as scheduled today and give its scheduled time. A scheduled start time passing proves only that the scheduled start time passed, not that the service is currently in progress or completed.',
    '- Evidence precedence: live database/provider state > deterministic derived metrics > workspace policy/config > audited execution records > summaries/memory > inference.',
    '- Facts in this block override conflicting conversation history, prior summaries, observations, memories, and guesses.',
    '- Separate facts from interpretation. If authoritative evidence does not establish a claim, say what is known and what is not established.',
    '- Capability claims must come from the deterministic AUTONOMY/tool-policy blocks in this prompt. Do not invent background abilities or limitations from prior conversation.',
  ]

  const o = state.outreach
  if (o) {
    const running = o.enabled && !o.paused
    lines.push(
      '',
      'OUTREACH — AUTHORITATIVE FACTS',
      `- outreach_enabled: ${o.enabled}`,
      `- outreach_paused: ${o.paused}`,
      `- outreach_running_now: ${running}`,
      `- sends_today_total: ${o.sendsToday.sent}`,
      `- first_touches_sent_today: ${o.sendsToday.firstTouch}`,
      `- followups_sent_today: ${o.sendsToday.followups}`,
      `- daily_first_touch_target: ${o.sendsToday.firstTouchTarget}`,
      `- daily_first_touch_remaining: ${o.sendsToday.firstTouchRemaining}`,
      `- first_touch_sends_this_month: ${o.sendsThisMonth.firstTouch}`,
      `- followup_sends_this_month: ${o.sendsThisMonth.followups}`,
      `- total_sends_this_month: ${o.sendsThisMonth.total}`,
      `- pending_outreach_drafts: ${o.queue.pendingDrafts}`,
      `- stalled_outreach_items: ${o.queue.stalled}`,
      `- active_sourcing_jobs: ${o.queue.sourcingJobs}`,
      `- sendable_sourced_leads: ${o.sourcing.availableCandidates}`,
      `- cooldown_candidates: ${o.sourcing.cooldownCandidates}`,
      `- outbound_provider_connected: ${o.provider.connected}`,
      `- outbound_provider_healthy: ${o.provider.healthy}`,
      `- telemetry_complete: ${o.telemetryComplete}`,
      `- exact_zero_send_reason_today: ${o.reasonNoOutreach ?? 'none — outreach has sent today or no zero-send explanation applies'}`,
      '',
      'OUTREACH CLAIM CONSTRAINTS — DETERMINISTIC',
      '- If total_sends_this_month > 0, you MUST NOT say or imply that zero emails have been sent this month, that nothing has been sent this month, or that the funnel has never moved.',
      '- The daily acquisition goal is first touches only. Follow-ups are useful but MUST NOT be described as satisfying or consuming the first-touch target.',
      '- outreach_paused=false means you MUST NOT call outreach "paused". outreach_running_now is the exact combined enabled+pause state.',
      '- Pending drafts are a queue fact, not proof that the entire funnel is blocked. If month sends are nonzero, you MUST NOT infer "zero sent" or "nothing is flowing" solely from draft count.',
      '- If telemetry_complete=false, do not invent a single root cause. State what is known and what is not established.'
    )
  }

  return lines.join('\n')
}
