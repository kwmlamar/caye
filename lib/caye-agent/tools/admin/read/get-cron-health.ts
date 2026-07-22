import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'
import { CRON_JOBS } from '../cron-registry'

export const getCronHealth: Tool<Record<string, never>> = {
  name: 'get_cron_health',
  description:
    'Report last-run status for each known Caye cron (morning-digest, escalation-followup, gmail-poll): when it last started/finished, ok/error, duration, and a summary of what it did. Call this before answering any status question — never guess from memory.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute() {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('caye_cron_runs')
      .select('cron_name, last_started_at, last_finished_at, last_status, last_summary, last_error, last_duration_ms')

    if (error) return { ok: false, error: error.message }

    const byName = new Map((data ?? []).map((row) => [row.cron_name, row]))
    const report = Object.entries(CRON_JOBS).map(([name, { label }]) => {
      const row = byName.get(name)
      if (!row) {
        return { cron_name: name, label, status: 'never_run' as const }
      }
      return {
        cron_name: name,
        label,
        last_started_at: row.last_started_at,
        last_finished_at: row.last_finished_at,
        last_status: row.last_status,
        last_summary: row.last_summary,
        last_error: row.last_error,
        last_duration_ms: row.last_duration_ms,
      }
    })

    return { ok: true, data: { crons: report } }
  },
}
