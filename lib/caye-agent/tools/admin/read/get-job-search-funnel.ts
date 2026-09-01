import 'server-only'
import { computeFunnelMetrics } from '@/lib/job-search/funnel-metrics'
import type { Tool } from '../../types'

type Input = { since?: string }

export const getJobSearchFunnel: Tool<Input> = {
  name: 'get_job_search_funnel',
  description:
    'Get job-search funnel metrics: applications, responses, positive responses, screens, interviews, offers, rejections, ghosted; response rate, positive-response rate, interview conversion, median response time; and a breakdown by job title, source, and application strategy (automated ATS vs manual). Use for "how is the job search going" / "what\'s working" type questions. Optionally pass `since` (ISO date) to scope to applications prepared on or after that date.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string', description: 'ISO date — only count applications prepared on or after this date. Omit for all-time.' },
    },
  },

  async execute(args) {
    try {
      const metrics = await computeFunnelMetrics(args.since)
      return { ok: true, data: metrics }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not compute job-search funnel metrics' }
    }
  },
}
