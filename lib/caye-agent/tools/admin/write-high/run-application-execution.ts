import 'server-only'
import { executeApplication } from '@/lib/job-search/execution/executor'
import type { Tool } from '../../types'

type Input = { application_id: string }

/** Explicit founder-triggered, single-application entry point. No URL input. */
export const runApplicationExecution: Tool<Input> = {
  name: 'run_application_execution',
  description: 'Run the founder job-search executor for one stored application ID. HIGH-RISK because a real submission is possible only after a separate confirmation; never accepts a URL or bulk selector.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: { type: 'object', required: ['application_id'], properties: { application_id: { type: 'string' } } },
  async execute(args) {
    try {
      return { ok: true, data: await executeApplication(args.application_id) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Application execution failed.' }
    }
  },
}
