import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import type { BlackoutRange } from '@/lib/services/operating-rules'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'

interface RemoveBlackoutDateInput {
  match: string
}

function describeRange(r: BlackoutRange): string {
  const rec = r.recurring_annually ? ' (annual)' : ''
  const lbl = r.label ? ` — ${r.label}` : ''
  return r.start === r.end ? `${r.start}${rec}${lbl}` : `${r.start} → ${r.end}${rec}${lbl}`
}

function isMatch(range: BlackoutRange, match: string): boolean {
  const m = match.trim().toLowerCase()
  if (range.label && range.label.toLowerCase() === m) return true
  if (range.start.toLowerCase() === m) return true
  if (range.start === m || range.end === m) return true
  // "Dec 23" / "Aug 1" style — match against describe shape
  if (describeRange(range).toLowerCase().includes(m)) return true
  return false
}

export const removeBlackoutDate: Tool<RemoveBlackoutDateInput> = {
  name: 'remove_blackout_date',
  description:
    `Remove a previously-set closure so Caye starts quoting + booking those dates again. ` +
    `Match by label (e.g. "Vacation"), start date, or any unique substring of the closure. ` +
    `Errors when multiple closures match — be more specific. ${HIGH_RISK_CONFIRMATION_PREAMBLE}`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      match: {
        type: 'string',
        description: 'Label, start date, or unique substring of the closure to remove.',
      },
    },
    required: ['match'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const { data: cfg } = await supabase
      .from('workspace_ai_config')
      .select('blackout_dates')
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle()

    const current = (cfg?.blackout_dates as BlackoutRange[] | null) ?? []
    if (current.length === 0) {
      return { ok: false, error: 'No blackouts configured for this workspace.' }
    }

    const matches = current
      .map((r, i) => ({ range: r, index: i }))
      .filter(({ range }) => isMatch(range, args.match))

    if (matches.length === 0) {
      return {
        ok: false,
        error: `No closure matches "${args.match}".`,
        data: { current_blackouts: current.map(describeRange) },
      }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple closures match "${args.match}" — be more specific.`,
        data: { matches: matches.map((m) => describeRange(m.range)) },
      }
    }

    const removed = matches[0]
    const next = current.filter((_, i) => i !== removed.index)
    const { error } = await supabase
      .from('workspace_ai_config')
      .update({ blackout_dates: next })
      .eq('workspace_id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        removed: describeRange(removed.range),
        remaining: next.length,
      },
    }
  },
}
