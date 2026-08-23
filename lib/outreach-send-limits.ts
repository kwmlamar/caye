import 'server-only'
import { createServiceClient } from './supabase-server'

/**
 * Preventive layer for the internal_sales sender's reputation, separate
 * from lib/outreach-kill-switch.ts (the reactive layer that trips on
 * observed bounces). This cap exists regardless of how many qualified
 * leads app/api/caye/outreach-sourcing-scan produces in a day — decisions-
 * log 2026-08-12: "the two aren't redundant: cap prevents the spike, kill
 * switch catches whatever gets through anyway."
 */
/** New-prospect acquisition target. Follow-ups never consume this capacity. */
export const OUTREACH_DAILY_FIRST_TOUCH_CAP = 50
/** @deprecated Use OUTREACH_DAILY_FIRST_TOUCH_CAP for acquisition policy. */
export const OUTREACH_DAILY_SEND_CAP = OUTREACH_DAILY_FIRST_TOUCH_CAP

/**
 * Number of outreach touches (first-touch opens + follow-up nudges) this
 * workspace has sent today, in UTC — matching every other outreach_leads
 * timestamp column, which are all UTC timestamptz.
 *
 * Exposed as a count, not just a boolean: app/api/caye/outreach-autosend-
 * scan checks this ONCE per run and then tracks a live remaining-budget
 * counter locally as it sends, rather than re-checking underDailyCap()
 * (which only reflects state from before the run started) before every
 * individual send — a single run processing a full batch could otherwise
 * blow past the cap within its own run.
 */
export async function countSentToday(workspaceId: string): Promise<number> {
  const { firstTouch, followups } = await countOutreachSendsToday(workspaceId)
  return firstTouch + followups
}

/** First touches and follow-ups are reported separately; they serve different goals. */
export async function countOutreachSendsToday(workspaceId: string): Promise<{ firstTouch: number; followups: number }> {
  const supabase = createServiceClient()
  const startOfDayUtc = new Date()
  startOfDayUtc.setUTCHours(0, 0, 0, 0)
  const cutoff = startOfDayUtc.toISOString()

  const [firstTouchToday, followupToday] = await Promise.all([
    supabase
      .from('outreach_leads')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('first_touch_sent_at', cutoff),
    supabase
      .from('outreach_leads')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('last_nudge_at', cutoff),
  ])

  return { firstTouch: firstTouchToday.count ?? 0, followups: followupToday.count ?? 0 }
}

/** True if the workspace has sent fewer than OUTREACH_DAILY_SEND_CAP touches today. Simple boolean for callers (e.g. the sourcing cron) that don't need a live running budget. */
export async function underDailyCap(workspaceId: string): Promise<boolean> {
  return (await countOutreachSendsToday(workspaceId)).firstTouch < OUTREACH_DAILY_FIRST_TOUCH_CAP
}
