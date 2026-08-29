import 'server-only'
import { setDailySubmissionCap as setDailySubmissionCapSetting } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

interface SetDailySubmissionCapInput {
  cap: number
}

/**
 * CAY-194: the low-volume rollout cap (issue: "low daily submission cap
 * (e.g. 3-5) for initial production validation ... not the 150/day policy
 * cap"). Gated high-risk in either direction — raising it is an obvious
 * increase in blast radius, and even lowering it is a deliberate rollout
 * decision worth a confirm step; keeping the rule symmetric is simpler and
 * safer than trying to special-case "this direction is fine."
 */
export const setDailySubmissionCap: Tool<SetDailySubmissionCapInput> = {
  name: 'set_daily_submission_cap',
  description:
    'Set the maximum number of real ATS submissions per day (independent of the 150/day sourcing/scoring policy cap — this is the initial low-volume rollout cap, e.g. 3-5). HIGH-RISK — confirmation is enforced in code: the first call only stages the change, then relay the summary and call again with identical arguments once the founder confirms in a NEW message.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: { cap: { type: 'number', description: 'New daily submission cap (non-negative integer).' } },
    required: ['cap'],
  },

  async execute(args) {
    try {
      await setDailySubmissionCapSetting(args.cap, 'founder')
      return { ok: true, data: { daily_submission_cap: args.cap } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not set daily submission cap' }
    }
  },
}
