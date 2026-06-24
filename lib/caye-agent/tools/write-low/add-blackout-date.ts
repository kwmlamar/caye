import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import type { BlackoutRange } from '@/lib/services/operating-rules'

interface AddBlackoutDateInput {
  start: string
  end?: string
  reason?: string
  recurring_annually?: boolean
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MM_DD = /^\d{2}-\d{2}$/

export const addBlackoutDate: Tool<AddBlackoutDateInput> = {
  name: 'add_blackout_date',
  description:
    "Mark a date or date range as closed. Caye stops quoting + booking on those dates and " +
    "replies that the business is closed.\n\n" +
    "One-time closures (vacation): pass dates as 'YYYY-MM-DD'. recurring_annually=false " +
    "(default).\n\n" +
    "Annual closures (every year on the same dates): pass dates as 'MM-DD' AND set " +
    "recurring_annually=true. The Bimini Dec 23 → Jan 3 holiday wrap is this shape.\n\n" +
    "end is optional — when omitted, it's a single-day closure at start.\n\n" +
    "Existing bookings on those dates are NOT cancelled — closures only block future inquiries.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description: "Start date. 'YYYY-MM-DD' for one-time closures, 'MM-DD' when recurring_annually=true.",
      },
      end: {
        type: 'string',
        description: "Inclusive end date (same format as start). Omit for a single-day closure.",
      },
      reason: { type: 'string', description: 'Short label shown in the closure ("Holiday", "Vacation").' },
      recurring_annually: {
        type: 'boolean',
        description: 'true = dates are MM-DD and apply every year. Default false.',
      },
    },
    required: ['start'],
  },

  async execute(args, ctx) {
    const recurring = args.recurring_annually === true
    const pattern = recurring ? MM_DD : ISO_DATE
    if (!pattern.test(args.start)) {
      return {
        ok: false,
        error: recurring
          ? "Recurring blackouts must use MM-DD format (e.g. '12-23')."
          : "One-time blackouts must use YYYY-MM-DD format (e.g. '2026-12-23').",
      }
    }
    const end = args.end ?? args.start
    if (!pattern.test(end)) {
      return { ok: false, error: 'end must match the same format as start.' }
    }

    const range: BlackoutRange = {
      start: args.start,
      end,
      ...(args.reason ? { label: args.reason.trim() } : {}),
      ...(recurring ? { recurring_annually: true } : {}),
    }

    const supabase = createServiceClient()
    const { data: cfg } = await supabase
      .from('workspace_ai_config')
      .select('blackout_dates')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()

    const current = (cfg?.blackout_dates as BlackoutRange[] | null) ?? []
    const next = [...current, range]

    const { error } = await supabase
      .from('workspace_ai_config')
      .update({ blackout_dates: next })
      .eq('workspace_id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        added: range,
        total_blackouts: next.length,
      },
    }
  },
}
