import 'server-only'
import type { Tool } from '../types'
import { listActiveEligibleGoals, resolveAncestorChain } from '@/lib/goals/goals'
import { sortByPriorityScore } from '@/lib/goals/priority-score'

/**
 * Goal-aware context for the back-office agent (and, via the same code
 * path, the opportunity-scan heartbeat prompt). Returns ONLY this
 * workspace's active, actionable goals — never 'future'/'blocked'/'paused'
 * goals (those aren't current work regardless of how interesting they are),
 * never operator/global-scope goals (this tool is always called with a
 * workspace's ctx.workspaceId; it has no code path to the founder's
 * cross-workspace direction — see lib/goals/goals.ts module doc comment).
 *
 * This is informational only. It does not change what Caye is allowed to
 * do — the authority/confirmation gate (high-risk-gate.ts) is unaffected
 * by anything this tool returns. A goal explains why an action might be
 * worth proposing; it never authorizes one.
 */
export const listActiveGoals: Tool<Record<string, never>> = {
  name: 'list_active_goals',
  description:
    'Show this workspace\'s currently active objectives/goals and why they matter — use this to understand ' +
    "what the business is trying to accomplish right now before deciding what's worth surfacing or proposing. " +
    "Does not include future/blocked/paused goals — those aren't current priorities. Does not grant permission " +
    'to do anything; your normal tools and confirmation rules still apply.',
  risk: 'read',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    const goals = await listActiveEligibleGoals(ctx.workspaceId)
    if (goals.length === 0) {
      return { ok: true, data: { goals: [], note: 'No active goals set for this workspace yet.' } }
    }
    const ranked = sortByPriorityScore(goals)
    const withChain = await Promise.all(
      ranked.map(async (g) => {
        const chain = await resolveAncestorChain(g.id)
        const ancestry = chain.slice(1).map((a) => a.title)
        return {
          id: g.id,
          kind: g.kind,
          title: g.title,
          description: g.description,
          priority: g.priority,
          target_value: g.targetValue,
          current_value: g.currentValue,
          unit: g.unit,
          target_date: g.targetDate,
          completion_criteria: g.completionCriteria,
          rationale: g.rationale,
          supports: ancestry.length > 0 ? ancestry : undefined,
        }
      })
    )
    return { ok: true, data: { goals: withChain } }
  },
}
