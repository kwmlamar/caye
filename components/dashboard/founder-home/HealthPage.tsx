'use client'

import { useState, useEffect, type ReactNode } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { quietPanel, TEXT_MUTED } from '@/components/dashboard/surface'

const LABEL_COLOR = '#71717a'
const OK_COLOR = '#34d399'
const BAD_COLOR = '#fb7185'

interface CronItem {
  cron_name: string
  label: string
  last_finished_at: string | null
  last_status: string | null
  last_error: string | null
  stale: boolean
}
interface WhatsAppItem {
  workspace_id: string
  business_name: string
  failure_streak: number
  unreachable: boolean
  last_confirmed_at: string | null
  no_confirmed_deliveries: boolean
}
interface HealthData {
  crons: { healthy: boolean; items: CronItem[] }
  whatsapp: { healthy: boolean; items: WhatsAppItem[] }
  migrations: { healthy: boolean; missing: string[]; repo_count: number; applied_count: number; error?: string }
  llm_activity: { healthy: boolean; last_call_at: string | null; stale: boolean }
  model_backends: { name: string; state: string; detail?: string }[]
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Icon + label + dot + one-line status per subsystem — functional glance
// over real data (cron/WhatsApp/migration/LLM signals that already exist
// and already alert independently), not a character moment. Used to carry
// an anatomical "Pulse/Lungs/Memory/Mind" framing; renamed to what each
// row actually checks (2026-08-26) since the point is a faster, more
// legible diagnostic than asking Caye in chat, and a metaphor a founder
// has to decode under time pressure works against that.
// One continuous, near-invisible panel for all four checks (2026-08-26)
// rather than four separate flat-gray boxes with gaps between them —
// hairline outline (quietPanel) instead of a filled card, closer to how
// Claude/ChatGPT's own lists read: content grouped by whitespace and row
// dividers, not a distinct surface floating on the page. Rows share
// hairline dividers instead of each owning a background + border radius,
// and get a hover tint so the whole row reads as clickable, not just the
// chevron.
function HealthSurface({ children }: { children: ReactNode }) {
  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', ...quietPanel }}>
      {children}
    </div>
  )
}

function OrganCard({
  icon, name, healthy, statusLine, children,
}: { icon: ReactNode; name: string; healthy: boolean; statusLine: string; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const [hover, setHover] = useState(false)
  const color = healthy ? OK_COLOR : BAD_COLOR
  return (
    <div style={{ boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.05)' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: hover ? 'rgba(255,255,255,0.025)' : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 10,
          background: `${color}17`, color, flexShrink: 0,
        }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: 7 }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}99`, flexShrink: 0 }} />
            {name}
          </div>
          <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {statusLine}
          </div>
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {expanded && children && (
        <div style={{ padding: '0 16px 14px' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', fontSize: 12, boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.03)' }}>
      <span style={{ color: TEXT_MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ color: color ?? '#d4d4d8', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

// Snapshot-on-load, no polling — this is a quick glance, not a live
// ticker (per the functional-not-vibe purpose this page was built for).
export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/health', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled) return
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setData(json)
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (error) {
    return <div style={{ flex: 1, padding: 20, fontSize: 12.5, color: BAD_COLOR }}>{error}</div>
  }
  if (data === null) {
    return <div style={{ flex: 1, padding: 20 }}><CayeLoadingPulse size={16} /></div>
  }

  const staleCrons = data.crons.items.filter((c) => c.stale || c.last_status === 'error')
  const flaggedWhatsapp = data.whatsapp.items.filter((w) => w.unreachable || w.failure_streak > 0 || w.no_confirmed_deliveries)

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, minHeight: 0, maxWidth: 640 }}>
    <HealthSurface>
      <OrganCard
        icon={<path d="M3 12h4l2-8 4 16 3-11 2 3h5" />}
        name="Scheduled jobs"
        healthy={data.crons.healthy}
        statusLine={data.crons.healthy ? `All ${data.crons.items.length} crons on schedule` : `${staleCrons.length} of ${data.crons.items.length} crons stale or failing`}
      >
        {data.crons.items.map((c) => (
          <DetailRow
            key={c.cron_name}
            label={c.label}
            value={c.last_status === 'error' ? `error — ${fmtAgo(c.last_finished_at)}` : c.stale ? `stale — last ${fmtAgo(c.last_finished_at)}` : `ok — ${fmtAgo(c.last_finished_at)}`}
            color={c.stale || c.last_status === 'error' ? BAD_COLOR : OK_COLOR}
          />
        ))}
      </OrganCard>

      <OrganCard
        icon={<><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 20l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></>}
        name="Message delivery"
        healthy={data.whatsapp.healthy}
        statusLine={data.whatsapp.healthy ? `All ${data.whatsapp.items.length} workspaces confirming delivery` : `${flaggedWhatsapp.length} of ${data.whatsapp.items.length} workspaces flagged`}
      >
        {data.whatsapp.items.length === 0 ? (
          <div style={{ padding: '8px 0', fontSize: 12, color: LABEL_COLOR }}>No workspaces with WhatsApp outbound enabled.</div>
        ) : (
          data.whatsapp.items.map((w) => {
            const flagged = w.unreachable || w.failure_streak > 0 || w.no_confirmed_deliveries
            const detail = w.unreachable
              ? 'unreachable'
              : w.failure_streak > 0
                ? `${w.failure_streak} failed in a row`
                : w.no_confirmed_deliveries
                  ? 'no confirmed deliveries'
                  : `confirmed ${fmtAgo(w.last_confirmed_at)}`
            return <DetailRow key={w.workspace_id} label={w.business_name} value={detail} color={flagged ? BAD_COLOR : OK_COLOR} />
          })
        )}
      </OrganCard>

      <OrganCard
        icon={<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 4v16" /></>}
        name="Database"
        healthy={data.migrations.healthy}
        statusLine={
          data.migrations.error
            ? 'Drift check failed'
            : data.migrations.healthy
              ? `${data.migrations.applied_count} of ${data.migrations.repo_count} migrations applied`
              : `${data.migrations.missing.length} migration(s) never applied`
        }
      >
        {data.migrations.error ? (
          <div style={{ padding: '8px 0', fontSize: 12, color: BAD_COLOR }}>{data.migrations.error}</div>
        ) : data.migrations.missing.length === 0 ? (
          <div style={{ padding: '8px 0', fontSize: 12, color: LABEL_COLOR }}>Repo and database agree.</div>
        ) : (
          data.migrations.missing.map((m) => <DetailRow key={m} label={m} value="not applied" color={BAD_COLOR} />)
        )}
      </OrganCard>

      <OrganCard
        icon={<path d="M3 12h4l2-9 4 18 2-9h6" />}
        name="Model activity"
        healthy={data.llm_activity.healthy}
        statusLine={data.llm_activity.last_call_at ? `Last call ${fmtAgo(data.llm_activity.last_call_at)}` : 'No LLM calls recorded'}
      />

      <OrganCard
        icon={<path d="M5 12h14M12 5v14" />}
        name="Model backends"
        healthy={data.model_backends.some((b) => b.state === 'available' || b.state === 'healthy')}
        statusLine={data.model_backends.map((b) => `${b.name}: ${b.state.replace('_', ' ')}`).join(' · ')}
      >
        {data.model_backends.map((b) => (
          <DetailRow
            key={b.name}
            label={b.name}
            value={b.detail ?? b.state.replace('_', ' ')}
            color={b.state === 'available' || b.state === 'healthy' ? OK_COLOR : BAD_COLOR}
          />
        ))}
      </OrganCard>
    </HealthSurface>
    </div>
  )
}
