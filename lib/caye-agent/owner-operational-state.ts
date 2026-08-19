import 'server-only'
import { getOutreachOperationalStatus, type OutreachOperationalStatus } from '@/lib/outreach-operational-status'

export interface AuthoritativeOwnerOperationalState {
  capturedAt: string
  outreach: OutreachOperationalStatus
}

/**
 * Deterministic gate for owner questions that require a fresh operational read
 * before the model reasons. This deliberately includes broad executive-status
 * questions because outreach can be a material business subsystem even when
 * the owner does not use the word "outreach" explicitly.
 */
export function needsAuthoritativeOwnerOperationalState(message: string): boolean {
  const text = message.trim().toLowerCase()
  if (!text) return false
  return /\b(outreach|autosend|auto-send|lead(?:s)?|draft(?:s)?|email(?:s|ing)?|send(?:s|ing)?|sourcing|pipeline|funnel|bottleneck)\b/.test(text) ||
    /\b(what(?:'s| is) going on|what have you done|what(?:'s| is) working|what isn(?:'t| not) working|what should i (?:know|pay attention to)|what are you (?:working on|currently working on)|anything (?:i should know|you need from me)|what can you handle|what requires me|if i disappeared|run(?:ning)? the business)\b/.test(text)
}

export async function loadAuthoritativeOwnerOperationalState(
  workspaceId: string,
  message: string
): Promise<AuthoritativeOwnerOperationalState | null> {
  if (!needsAuthoritativeOwnerOperationalState(message)) return null
  return {
    capturedAt: new Date().toISOString(),
    outreach: await getOutreachOperationalStatus(workspaceId),
  }
}

/**
 * Render only machine-derived facts. The wording is intentionally explicit
 * about precedence so history, summaries, memory, and LLM inference cannot
 * silently overwrite current system-of-record state.
 */
export function renderAuthoritativeOwnerOperationalState(
  state: AuthoritativeOwnerOperationalState | null
): string | null {
  if (!state) return null
  const o = state.outreach
  const running = o.enabled && !o.paused
  return [
    'AUTHORITATIVE OPERATIONAL STATE — SYSTEM OF RECORD, READ BEFORE REASONING',
    `- Snapshot captured: ${state.capturedAt}`,
    '- Evidence precedence: live database/provider state > deterministic derived metrics > workspace policy/config > audited execution records > summaries/memory > inference.',
    '- Facts in this block override conflicting conversation history, prior summaries, observations, memories, and guesses.',
    '- Separate facts from interpretation. You may infer a likely bottleneck only after stating/using these facts; if they do not establish one, say that plainly.',
    '',
    'OUTREACH — AUTHORITATIVE FACTS',
    `- outreach_enabled: ${o.enabled}`,
    `- outreach_paused: ${o.paused}`,
    `- outreach_running_now: ${running}`,
    `- sends_today_total: ${o.sendsToday.sent}`,
    `- daily_send_limit: ${o.sendsToday.dailyLimit}`,
    `- daily_send_remaining: ${o.sendsToday.remaining}`,
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
    'CLAIM CONSTRAINTS — DETERMINISTIC',
    `- If total_sends_this_month > 0, you MUST NOT say or imply that zero emails have been sent this month, that nothing has been sent this month, or that the funnel has never moved.`,
    `- outreach_paused=false means you MUST NOT call outreach "paused". outreach_running_now is the exact combined enabled+pause state.`,
    `- Pending drafts are a queue fact, not proof that the entire funnel is blocked. If month sends are nonzero, you MUST NOT infer "zero sent" or "nothing is flowing" solely from draft count.`,
    `- If telemetry_complete=false, do not invent a single root cause. State what is known and what is not established.`,
    `- Capability claims must come from the deterministic AUTONOMY/tool-policy blocks in this prompt. Do not invent background abilities or limitations from prior conversation.`,
  ].join('\n')
}
