import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'
import { loadScheduleConfig } from '@/lib/whatsapp/schedule'
import {
  resolveReminderTime,
  formatReminderBody,
  describeReminderTime,
} from '@/lib/whatsapp/reminder-time'
import type { Tool } from '../types'

interface ScheduleReminderInput {
  date: string
  time: string
  message: string
}

/**
 * Set a reminder for the operator, delivered to their own WhatsApp.
 *
 * WHY THIS EXISTS (2026-08-09)
 * At the end of three hours clearing her queue, Mrs. Max asked: "are you able
 * to remind of meeting tomorrow for 8:30 and 9:30". The answer was "I'm not
 * able to set reminders — that's not something I can do yet, sorry."
 *
 * It was the only thing she asked for unprompted in the whole session — the
 * clearest sign so far that she's starting to treat Caye as staff rather than
 * as an inbox — and the machinery already existed: caye_outbound_queue has
 * scheduled_for, and a worker polls it every minute.
 *
 * Deliberately operator-only. Nothing here can reach a guest, which is why
 * it's low-risk and executes immediately rather than staging a confirmation.
 * Asking "shall I set that reminder?" after being told to set a reminder is
 * the kind of second confirmation the back-office prompt already forbids.
 */
export const scheduleReminder: Tool<ScheduleReminderInput> = {
  name: 'schedule_reminder',
  description: `Set a reminder that Caye sends back to the operator at a specific date and time. Goes to THEM on WhatsApp — it can never reach a customer.

Use whenever they ask to be reminded of anything: a meeting, a call, a payment due, checking whether a guest replied, following up on a quote.

TIME IS IN THEIR LOCAL TIME, and you must convert it yourself:
- date: 'YYYY-MM-DD'. Work out the real date from today's date — "tomorrow", "Friday", "the 20th" are yours to resolve, never pass them through.
- time: 24-hour 'HH:MM'. "8:30" in the morning is '08:30'; "half 8 tonight" is '20:30'.

ONE CALL PER REMINDER. "remind me at 8:30 and 9:30" is two calls, not one reminder mentioning both times.

Keep the message short and in their words — it gets sent back to them verbatim, so it should make sense read cold hours later with no other context. "Meeting" is too thin; "meeting with the cruise rep" is right.

If they're vague about which day, ask rather than guess — a reminder that fires on the wrong day is worse than none.`,
  risk: 'low',
  roles: ['owner', 'founder', 'staff'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: "Local calendar date, 'YYYY-MM-DD'. Resolve relative words like 'tomorrow' yourself against today's date.",
      },
      time: {
        type: 'string',
        description: "Local time, 24-hour 'HH:MM'. Convert am/pm yourself.",
      },
      message: {
        type: 'string',
        description: "What to remind them about, in their own words. Sent back verbatim; must stand alone hours later.",
      },
    },
    required: ['date', 'time', 'message'],
  },

  async execute(args, ctx) {
    const message = args.message?.trim()
    if (!message) return { ok: false, error: 'I need to know what to remind you about.' }

    const supabase = createServiceClient()
    const { timezone } = await loadScheduleConfig(ctx.workspaceId)

    const resolved = resolveReminderTime({
      dateISO: args.date,
      timeHHMM: args.time,
      timezone,
    })
    if (!resolved.ok) return { ok: false, error: resolved.error }

    // Deliver to the operator who asked, not to the workspace's canonical
    // notification number — staff and founder both reach this tool, and a
    // reminder is personal to whoever set it.
    let phone = ctx.callerPhone ?? null
    if (!phone && ctx.operatorId != null) {
      const { data } = await supabase
        .from('operator_allowlist')
        .select('phone')
        .eq('id', ctx.operatorId)
        .maybeSingle()
      phone = (data as { phone: string } | null)?.phone ?? null
    }
    if (!phone) {
      return {
        ok: false,
        error: "I can't work out which number to send it to — set it from WhatsApp and I'll have your number.",
      }
    }

    const queued = await enqueueOutbound({
      workspaceId: ctx.workspaceId,
      kind: 'operator_reminder',
      payload: {
        body: formatReminderBody(message),
        to_phone: phone,
        // Kept for the Caye Direct mirror, which shows what was asked for
        // rather than the decorated outbound text.
        original_request: message,
      },
      scheduledFor: resolved.fireAtUTC,
      // One reminder per operator per minute per wording. Re-asking for the
      // same thing shouldn't double-send; asking for 8:30 AND 9:30 still
      // produces two rows, since the timestamp differs.
      idempotencyKey: `reminder-${ctx.workspaceId}-${phone}-${resolved.fireAtUTC.toISOString()}`,
    })

    if (!queued) {
      return {
        ok: false,
        error:
          "I couldn't queue that — notifications are paused on this workspace, so it wouldn't have reached you.",
      }
    }

    return {
      ok: true,
      data: {
        reminder_id: queued.id,
        fires_at_local: describeReminderTime(resolved.fireAtUTC, timezone),
        timezone,
        message,
        // Stated because it's the one real limitation and she should hear it
        // once, not discover it by missing a reminder: a free-form WhatsApp
        // send needs her to have messaged Caye within 24h of the fire time.
        // She does daily, so this is nearly always fine — and it lands in
        // Caye Direct regardless.
        delivery_note:
          'Confirm the local time back to them. If the reminder is more than 24h away and they might not message me before then, mention it may land in Caye Direct rather than WhatsApp.',
      },
    }
  },
}
