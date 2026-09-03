import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { resolveCrewDayPolicy, unconfirmed } from '@/lib/domain-policy'
import type { Tool } from '../types'

/**
 * Let the business correct an assumption by saying so.
 *
 * Caye ships with defaults measured from ODS's own history — an hour lunch, an
 * 07:00-16:00 day, overtime off. They are decent defaults and they are still
 * guesses about how a business we do not run wants to work. Without this tool
 * the only way to correct one is a deploy, which means in practice the guess
 * wins and the system slowly stops matching the business.
 *
 * Deliberately `low` risk. It changes no ledger row: every crew day is still
 * staged and confirmed before anything is written, so a wrong policy produces a
 * summary somebody can reject rather than a payroll entry nobody saw.
 *
 * The one thing it must never do is clobber the rest of the binding's config —
 * the same object carries the ledger URL and the operator identity mappings, so
 * a careless overwrite would sever the connection or, worse, silently
 * de-attribute writes. It merges, and it refuses anything that smells like a
 * credential.
 */

const CREW_DAY_KEYS = [
  'break_minutes',
  'standard_start',
  'standard_end',
  'overtime_enabled',
  'reporter_logs_own_time',
  'refuse_duplicates',
] as const

const SECRET_ISH = /(key|secret|token|password|credential)/i

interface SetConstructionPolicyInput {
  break_minutes?: number
  standard_start?: string
  standard_end?: string
  overtime_enabled?: boolean
  reporter_logs_own_time?: boolean
  refuse_duplicates?: boolean
}

export const setConstructionPolicy: Tool<SetConstructionPolicyInput> = {
  name: 'set_construction_policy',
  description:
    "Record how this business actually works, so Caye stops using a default and uses their answer. " +
    'Use it when the owner corrects an assumption — "lunch is half an hour", "we start at 6:30", ' +
    '"Omar should be on the timesheet too", "overtime after 8 hours". ALSO use it when they CONFIRM one: ' +
    'if preview_crew_day asked about the hour lunch and they say "yeah that\'s right", record 60 anyway. ' +
    'That is what stops Caye asking the same question every day. Changes no existing record and ' +
    'writes nothing to the ledger: it only changes what future crew days assume, and those are still ' +
    'confirmed before anything is written. Always read back what changed and what it now assumes.',
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      break_minutes: {
        type: 'number',
        description: 'Unpaid break per day, in minutes. Currently assumed 60 because every past entry uses that.',
      },
      standard_start: { type: 'string', description: 'Normal start time, HH:MM, 24-hour. e.g. "06:30".' },
      standard_end: { type: 'string', description: 'Normal finish time, HH:MM, 24-hour. e.g. "16:00".' },
      overtime_enabled: {
        type: 'boolean',
        description:
          'Whether Caye may record overtime hours. Off by default because no overtime policy is written down ' +
          'anywhere in this business. Only turn this on once the owner states the actual rule.',
      },
      reporter_logs_own_time: {
        type: 'boolean',
        description:
          'Whether the person reporting a crew day is also on it. Off by default because supervisors here are ' +
          'not on the hourly roster. Turning it on also needs them to exist as a worker in the ledger.',
      },
      refuse_duplicates: {
        type: 'boolean',
        description:
          'Whether to refuse a day that would duplicate existing entries. On by default — a day written twice ' +
          "doubles somebody's pay. Only turn this off deliberately.",
      },
    },
  },

  async execute(args, ctx) {
    const requested = Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
    if (!requested.length) {
      return { ok: false, error: 'Nothing to change. Say which assumption is wrong.' }
    }

    for (const [key] of requested) {
      if (!CREW_DAY_KEYS.includes(key as (typeof CREW_DAY_KEYS)[number]) || SECRET_ISH.test(key)) {
        return { ok: false, error: `"${key}" is not a construction policy setting.` }
      }
    }

    if (args.break_minutes !== undefined && (args.break_minutes < 0 || args.break_minutes > 8 * 60)) {
      return { ok: false, error: 'A break has to be between 0 minutes and 8 hours.' }
    }
    for (const field of ['standard_start', 'standard_end'] as const) {
      const value = args[field]
      if (value !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
        return { ok: false, error: `${field} must be a 24-hour time like "06:30".` }
      }
    }

    const supabase = createServiceClient()
    const { data: connection, error: readError } = await supabase
      .from('domain_source_connections')
      .select('id, config')
      .eq('workspace_id', ctx.workspaceId)
      .eq('source_system', 'bedrock')
      .maybeSingle()

    if (readError) return { ok: false, error: `Could not read the ledger settings — ${readError.message}` }
    if (!connection) return { ok: false, error: 'This workspace is not connected to a construction ledger.' }

    // Merge, never replace. This object also carries the ledger URL and the
    // operator identity mappings; overwriting it would sever the connection or
    // silently de-attribute every future write.
    const config = (connection.config ?? {}) as Record<string, unknown>
    const policy = { ...((config.policy as Record<string, unknown>) ?? {}) }
    const crewDay = { ...((policy.crew_day as Record<string, unknown>) ?? {}) }
    for (const [key, value] of requested) crewDay[key] = value

    const nextConfig = { ...config, policy: { ...policy, crew_day: crewDay } }

    const { error: writeError } = await supabase
      .from('domain_source_connections')
      .update({ config: nextConfig, updated_at: new Date().toISOString() })
      .eq('id', connection.id)

    if (writeError) return { ok: false, error: `Could not save that — ${writeError.message}` }

    const resolved = resolveCrewDayPolicy(nextConfig)
    return {
      ok: true,
      data: {
        changed: Object.fromEntries(requested),
        now_assumes: {
          break_minutes: resolved.breakMinutes.value,
          standard_start: resolved.standardStart.value,
          standard_end: resolved.standardEnd.value,
          overtime_enabled: resolved.overtimeEnabled.value,
          reporter_logs_own_time: resolved.reporterLogsOwnTime.value,
          refuse_duplicates: resolved.refuseDuplicates.value,
        },
        // Named so the owner can see what is still a guess and correct the next
        // one in the same conversation, rather than discovering it later.
        still_assumed: unconfirmed(resolved),
        note: 'Applies to crew days logged from now on. Nothing already recorded was changed.',
      },
    }
  },
}
