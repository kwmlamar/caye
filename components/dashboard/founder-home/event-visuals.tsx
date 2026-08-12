import type { EventTone } from '@/lib/useLiveEvents'

export const TONE_COLOR: Record<EventTone, string> = { positive: '#34d399', neutral: '#4EBECE', alert: '#fb7185' }

// Splits "Booking confirmed — Maria R." into a title/subtitle pair for a
// two-line row, matching how these labels are actually built server-side
// (lib is app/api/founder/live-events/route.ts's labelFor). Falls back to
// a bare title when there's no " — ".
export function splitLabel(label: string): { title: string; subtitle: string | null } {
  const idx = label.indexOf(' — ')
  if (idx === -1) return { title: label, subtitle: null }
  return { title: label.slice(0, idx), subtitle: label.slice(idx + 3) }
}

const ICON_PATHS: Record<string, React.ReactNode> = {
  'message.inbound': <path d="M4 4h16v12H8l-4 4V4z" />,
  'booking.created': <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  'escalation.opened': <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></>,
  'escalation.resolved': <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>,
  'channel.disconnected': <><path d="M9 15l6-6M4 9V5h4M20 15v4h-4" /></>,
  'channel.reconnected': <><path d="M9 15l6-6M4 5l16 14" /></>,
}

const DEFAULT_ICON = <circle cx="12" cy="12" r="4" />

export function EventIcon({ type, tone, size = 32 }: { type: string; tone: EventTone; size?: number }) {
  const color = TONE_COLOR[tone]
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size, borderRadius: 9, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `${color}17`,
      }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[type] ?? DEFAULT_ICON}
      </svg>
    </div>
  )
}

export function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
