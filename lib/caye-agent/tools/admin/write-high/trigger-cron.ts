import 'server-only'
import type { Tool } from '../../types'
import { CRON_JOBS } from '../cron-registry'

interface TriggerCronInput {
  cron_name: string
}

/**
 * Manually run one of Caye's known crons on demand. Registered pre-wrapped
 * with gateAdminHighRisk in registry.ts — this raw execute() is only ever
 * reached on the SECOND (confirming) call, per that gate's mechanism.
 *
 * Deliberately closed: cron_name is enum-constrained to CRON_JOBS' keys,
 * so this can only ever run one of three hardcoded, already-reviewed
 * functions — never an arbitrary command, script path, or shell string.
 */
export const triggerCron: Tool<TriggerCronInput> = {
  name: 'trigger_cron',
  description:
    'Manually run one of the known Caye crons right now, instead of waiting for its schedule. Use when the founder asks to "run the X cron" / "trigger X" / "kick off X now".',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: {
      cron_name: {
        type: 'string',
        enum: Object.keys(CRON_JOBS),
        description: 'Which cron to run. One of: ' + Object.keys(CRON_JOBS).join(', '),
      },
    },
    required: ['cron_name'],
  },

  async execute(args) {
    const job = CRON_JOBS[args.cron_name]
    if (!job) {
      return { ok: false, error: `Unknown cron_name "${args.cron_name}". Valid options: ${Object.keys(CRON_JOBS).join(', ')}` }
    }
    try {
      const result = await job.run()
      return { ok: true, data: { cron_name: args.cron_name, label: job.label, result } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `${args.cron_name} run failed` }
    }
  },
}
