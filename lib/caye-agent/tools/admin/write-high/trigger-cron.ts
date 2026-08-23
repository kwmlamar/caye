import 'server-only'
import type { Tool } from '../../types'
import { CRON_JOBS } from '../cron-registry'

interface TriggerCronInput {
  cron_name: string
  force?: boolean
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
    'Manually run one of the known Caye crons right now, instead of waiting for its schedule. Use when the founder asks to "run the X cron" / "trigger X" / "kick off X now". ' +
    'By default this still respects each cron\'s own cadence gate — e.g. opportunity-scan only actually does anything inside its 10am/2pm/6pm local windows, so running it outside those hours will just report "skip". ' +
    'Pass force: true to bypass that cadence gate (opportunity-scan and business-insights only — the others ignore it) when the founder specifically wants to see a real run right now for testing. ' +
    'force does NOT bypass a workspace\'s muted/quiet-hours setting — those are the owner\'s own do-not-disturb preference and stay enforced even when forcing.',
  risk: 'high',
  roles: ['founder'],
  // Founder-confirmed operational control is available from the normal
  // back-office conversation too; it still calls only CRON_JOBS above.
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      cron_name: {
        type: 'string',
        enum: Object.keys(CRON_JOBS),
        description: 'Which cron to run. One of: ' + Object.keys(CRON_JOBS).join(', '),
      },
      force: {
        type: 'boolean',
        description:
          "Bypass the cron's cadence gate (opportunity-scan/business-insights only) so it runs for real right now instead of reporting 'skip'. Still respects muted/quiet-hours.",
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
      const result = await job.run(args.force ? { force: true } : undefined)
      return { ok: true, data: { cron_name: args.cron_name, label: job.label, result } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `${args.cron_name} run failed` }
    }
  },
}
