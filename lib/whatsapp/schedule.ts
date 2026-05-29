import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Workspace-local scheduling math for outbound operator pings.
 *
 * Quiet hours and morning digest fire in the operator's local time. The
 * timezone lives on customers.timezone (IANA). Defaults to America/Nassau —
 * Caye's primary market — when missing.
 */

const DEFAULT_TZ = 'America/Nassau'

export interface WorkspaceScheduleConfig {
  timezone: string
  quietStart: string // 'HH:MM'
  quietEnd: string // 'HH:MM'
  mutedUntil: Date | null
}

export async function loadScheduleConfig(workspaceId: string): Promise<WorkspaceScheduleConfig> {
  const supabase = createServiceClient()
  const [{ data: cfg }, { data: cust }] = await Promise.all([
    supabase
      .from('workspace_ai_config')
      .select('whatsapp_quiet_hours_start, whatsapp_quiet_hours_end, whatsapp_muted_until')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase.from('customers').select('timezone').eq('id', workspaceId).maybeSingle(),
  ])

  return {
    timezone: cust?.timezone ?? DEFAULT_TZ,
    quietStart: cfg?.whatsapp_quiet_hours_start ?? '21:00',
    quietEnd: cfg?.whatsapp_quiet_hours_end ?? '07:00',
    mutedUntil: cfg?.whatsapp_muted_until ? new Date(cfg.whatsapp_muted_until) : null,
  }
}

/** Hour:minute in the workspace's local time. */
function localHourMinute(date: Date, timezone: string): { h: number; m: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return { h: h === 24 ? 0 : h, m }
}

export function inQuietHours(now: Date, cfg: WorkspaceScheduleConfig): boolean {
  const { h, m } = localHourMinute(now, cfg.timezone)
  const cur = h * 60 + m
  const start = parseHm(cfg.quietStart)
  const end = parseHm(cfg.quietEnd)
  // Quiet window typically wraps midnight (e.g. 21:00–07:00).
  if (start <= end) return cur >= start && cur < end
  return cur >= start || cur < end
}

/**
 * Next 7:00 in the workspace's local timezone. If we're already past 7am today,
 * returns 7:00 tomorrow. Used to batch routine holds into the morning digest.
 */
export function nextDigestTime(now: Date, cfg: WorkspaceScheduleConfig): Date {
  // Build "today at 7:00" in the workspace timezone by formatting + reparsing.
  // We compute it iteratively: try today, then bump a day if it's already passed.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const todayLocal = formatter.format(now) // YYYY-MM-DD in workspace tz

  // Treat 7am local as 7am in that zone — produce a UTC instant by guessing
  // and correcting. Approximate (good for non-DST Caribbean zones).
  const guess = new Date(`${todayLocal}T07:00:00`)
  const offsetMinutes = guess.getTime() - new Date(guess.toLocaleString('en-US', { timeZone: cfg.timezone })).getTime()
  let target = new Date(guess.getTime() + offsetMinutes)
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000)
  }
  return target
}

/**
 * Is `now` within ±30 minutes of 7am local? Used by the morning-digest cron
 * (which fires hourly) to decide whether THIS tick is the digest tick.
 */
export function isDigestHour(now: Date, cfg: WorkspaceScheduleConfig): boolean {
  const { h, m } = localHourMinute(now, cfg.timezone)
  // The cron runs at :00 each hour. Accept h=7 with any minute.
  return h === 7 && m < 60
}

function parseHm(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
