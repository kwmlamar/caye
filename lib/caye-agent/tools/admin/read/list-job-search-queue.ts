import 'server-only'
import { getRankedQueue } from '@/lib/job-search/queue'
import type { Tool } from '../../types'

export const listJobSearchQueue: Tool<Record<string, never>> = {
  name: 'list_job_search_queue',
  description:
    'List the top-ranked QUEUED job-search candidates by fit score (company, title, location, score, apply URL). Call this for "show me the best 10" / "what\'s in the queue" type questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const queue = await getRankedQueue(10)
      return { ok: true, data: { queue } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read job-search queue' }
    }
  },
}
