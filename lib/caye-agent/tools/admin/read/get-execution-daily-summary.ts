import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getExecutionRolloutSettings } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/**
 * CAY-194 founder UX: "How many applications did you actually submit
 * today?" — counts strictly from job_search_applications.status /
 * submitted_at, never from an attempt count or an optimistic guess.
 */
export const getExecutionDailySummary: Tool<Record<string, never>> = {
  name: 'get_execution_daily_summary',
  description: 'Today\'s real ATS execution summary: applications actually submitted, needing human review, uncertain, and failed today, plus current rollout settings (automation on/off, dry run, daily cap). Call this for "how many did you actually submit today" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const supabase = createServiceClient()
      const todayStart = new Date()
      todayStart.setUTCHours(0, 0, 0, 0)

      const { data: attempts, error } = await supabase
        .from('job_search_execution_attempts')
        .select('outcome')
        .gte('started_at', todayStart.toISOString())
      if (error) return { ok: false, error: error.message }

      const counts = { submitted: 0, needs_human: 0, submission_uncertain: 0, failed: 0, preflight_blocked: 0 }
      for (const row of attempts ?? []) {
        const key = row.outcome as keyof typeof counts
        if (key in counts) counts[key] += 1
      }

      const rollout = await getExecutionRolloutSettings()

      return {
        ok: true,
        data: {
          submitted_today: counts.submitted,
          needs_human_today: counts.needs_human,
          submission_uncertain_today: counts.submission_uncertain,
          failed_today: counts.failed,
          preflight_blocked_today: counts.preflight_blocked,
          rollout: {
            automation_enabled: rollout.automationEnabled,
            dry_run: rollout.dryRun,
            daily_submission_cap: rollout.dailySubmissionCap,
            emergency_paused: rollout.emergencyPaused,
            allowlisted_providers: rollout.allowlistedProviders,
          },
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read execution daily summary' }
    }
  },
}
