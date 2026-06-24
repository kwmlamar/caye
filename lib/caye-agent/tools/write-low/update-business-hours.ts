import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

type DayCode = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
const DAY_ORDER: DayCode[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface UpdateBusinessHoursInput {
  day_of_week: DayCode
  open_time?: string
  close_time?: string
  closed?: boolean
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export const updateBusinessHours: Tool<UpdateBusinessHoursInput> = {
  name: 'update_business_hours',
  description:
    "Set the standard hours for a specific day of the week. Use when the owner says " +
    "\"we now close at 4 instead of 5 on Tuesdays\" or \"close us on Mondays — we're never " +
    "open then\".\n\n" +
    "Either set open_time + close_time (24-hour HH:MM) OR set closed=true to mark the day as " +
    "closed. Mixing closed=true with times is invalid.\n\n" +
    "Note: this sets the STANDARD weekly schedule. One-off closures (vacation, holiday) belong " +
    "in add_blackout_date instead — they take precedence over the weekly hours.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      day_of_week: {
        type: 'string',
        enum: DAY_ORDER,
        description: 'Three-letter lowercase day code.',
      },
      open_time: { type: 'string', description: '24-hour HH:MM (omit when closed=true).' },
      close_time: { type: 'string', description: '24-hour HH:MM (omit when closed=true).' },
      closed: { type: 'boolean', description: 'Set true to mark the day as closed (omit times).' },
    },
    required: ['day_of_week'],
  },

  async execute(args, ctx) {
    const day = args.day_of_week
    if (!DAY_ORDER.includes(day)) {
      return { ok: false, error: `Invalid day_of_week. Use one of: ${DAY_ORDER.join(', ')}` }
    }

    const closing = args.closed === true
    if (closing && (args.open_time || args.close_time)) {
      return { ok: false, error: 'closed=true must not be combined with open_time / close_time.' }
    }
    if (!closing) {
      if (!args.open_time || !args.close_time) {
        return { ok: false, error: 'open_time and close_time are both required unless closed=true.' }
      }
      if (!TIME_PATTERN.test(args.open_time) || !TIME_PATTERN.test(args.close_time)) {
        return { ok: false, error: 'Times must be in 24-hour HH:MM format.' }
      }
      if (args.open_time >= args.close_time) {
        return { ok: false, error: 'open_time must be earlier than close_time.' }
      }
    }

    const supabase = createServiceClient()
    const { data: customer } = await supabase
      .from('customers')
      .select('business_hours')
      .eq('id', ctx.workspaceId)
      .maybeSingle()

    const current = (customer?.business_hours as Record<string, unknown> | null) ?? {}
    const next = { ...current }
    if (closing) {
      next[day] = { closed: true }
    } else {
      next[day] = { open: args.open_time, close: args.close_time }
    }

    const { error } = await supabase
      .from('customers')
      .update({ business_hours: next })
      .eq('id', ctx.workspaceId)
    if (error) return { ok: false, error: error.message }

    return {
      ok: true,
      data: {
        day,
        new_hours: next[day],
      },
    }
  },
}
