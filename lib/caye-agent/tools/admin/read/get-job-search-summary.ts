import 'server-only'
import { getDailySummary } from '@/lib/job-search/summary'
import type { Tool } from '../../types'

/**
 * CAY-192 Phase 7 founder UX: "Find me jobs today" / "How many did you
 * apply to?" answer this via the live, already-wired Admin Shell tool
 * surface (WhatsApp + Admin Shell dashboard chat) — the CAY-27 capability
 * gateway (job_search.summary) exposes the same read for the newer
 * dashboard/MCP transports once those are wired into a live agent loop,
 * but this is what actually answers the founder today.
 */
export const getJobSearchSummary: Tool<Record<string, never>> = {
  name: 'get_job_search_summary',
  description:
    'Get today\'s job-search pipeline summary: roles sourced, qualified, needing founder review, submitted, and rejected (with reasons), plus whether the pipeline is paused. Call this for "find me jobs today", "how many did you apply to", "what needs me" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const summary = await getDailySummary()
      return { ok: true, data: summary }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read job-search summary' }
    }
  },
}
