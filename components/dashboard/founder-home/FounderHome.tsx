'use client'

import { useState, type ReactNode, type CSSProperties } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CayeMark } from '@/components/brand/CayeMark'
import { getSession } from '@/lib/supabase'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import type { FounderRailId } from '@/lib/types'
import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'
import CayeDirect from '@/components/dashboard/caye-direct/CayeDirect'
import ChannelsCard from '@/components/dashboard/founder-home/ChannelsCard'
import GlobalPerformance from '@/components/dashboard/global-performance/GlobalPerformance'
import ContactsPanel from '@/components/dashboard/founder-home/ContactsPanel'
import AdminShell from '@/components/dashboard/admin-shell/AdminShell'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill, GhostButton } from '@/components/dashboard/founder-home/console-ui'
import type { CustomerStatus } from '@/types/database'

// Tokens lifted directly from Sandbox/caye-command (the reference
// mockup) via computed styles — bg-[#09090b]/[#121214]/border-[#1f1f23],
// font-mono labels, font-display (Space Grotesk) values. The one thing
// NOT copied from the mockup is its cyan/purple/rose accent gradient —
// that's replaced with our own teal/gold mesh palette (matches the
// landing hero + CayeMark orb), per the earlier gradient-consistency
// decision. 2026-07-02 theme pass.
const APP_BG = '#111113'
const CARD_BG = '#1a1a1e'
const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a' // zinc-500
const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

// Glass treatment for chrome only (icon rail, top bar, floating buttons) —
// not the data-dense surfaces (stat cards, lists, calendar), which stay
// fully opaque so small mono text and escalation badges stay legible.
// See the "add transparency" discussion: scoped to navigation/framing.
const GLASS: CSSProperties = {
  backdropFilter: 'blur(20px) saturate(140%)',
  WebkitBackdropFilter: 'blur(20px) saturate(140%)',
}

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: 'Live',
  trial: 'Trial',
  inactive: 'Dormant',
  suspended: 'Blocked',
}
const STATUS_COLOR: Record<CustomerStatus, string> = {
  active: '#34d399', // emerald-400
  trial: '#FFD68F',
  inactive: '#71717a',
  suspended: '#fb7185', // rose-400
}

function StatusPill({ status }: { status: CustomerStatus }) {
  return <Pill color={STATUS_COLOR[status]} label={STATUS_LABEL[status]} />
}

function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false)
  const [hover, setHover] = useState(false)
  const active = focused || hover
  return (
    <button
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={expanded ? 'Collapse' : 'Expand'}
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1,
        width: 26, height: 26, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'rgba(125,201,203,0.16)' : 'rgba(255,255,255,0.08)',
        border: `1px solid ${active ? 'rgba(125,201,203,0.45)' : CARD_BORDER}`,
        color: active ? '#7DC9CB' : '#a1a1aa', cursor: 'pointer',
        outline: 'none', boxShadow: focused ? '0 0 0 2px rgba(125,201,203,0.35)' : 'none',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
        ...GLASS,
      }}
    >
      {expanded ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      )}
    </button>
  )
}

function StatCard({ label, value, valueColor = '#f4f4f5', action }: { label: string; value: string; valueColor?: string; action?: ReactNode }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      background: CARD_BG, borderRadius: 18, padding: '16px 18px',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 96,
    }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, color: valueColor, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </div>
        {action}
      </div>
    </div>
  )
}

// Founder-only pause/resume for a workspace's Caye deployment. Writes the
// same workspace_ai_config fields the back-office mute_caye/unmute_caye
// WhatsApp tools write (see app/api/founder/caye-toggle/route.ts) — a
// second entry point onto the same switch, added at explicit founder
// request even though the operating model otherwise routes controls like
// this through Caye-on-WhatsApp. Scoped to founders only, never shown to
// workspace owners.
function DeploymentToggle({ workspaceId, active, onToggled }: { workspaceId: string; active: boolean; onToggled: () => void }) {
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/caye-toggle', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId, active: !active }),
      })
      if (res.ok) onToggled()
    } finally {
      setBusy(false)
    }
  }

  return (
    <GhostButton
      label={active ? 'Pause' : 'Resume'}
      color={active ? '#fca5a5' : '#34d399'}
      onClick={handleClick}
      disabled={busy}
      busy={busy}
      title={active ? 'Pause Caye for this workspace' : 'Resume Caye for this workspace'}
    />
  )
}

// ── Icon rail ────────────────────────────────────────────────────────
// Plain inline SVGs rather than a new icon-library import — avoids
// guessing at export names for a package whose install layout couldn't
// be confirmed in this pass.
// RailId type lives in lib/types.ts as FounderRailId, imported below —
// it's shared with DashboardContext so the active tab survives workspace
// switches (which navigate to a new route and remount this component).
type RailId = FounderRailId

const RAIL_ITEMS: { id: RailId; label: string; icon: ReactNode; stub: boolean }[] = [
  { id: 'dashboard', label: 'Caye Command', stub: false, icon: (
    <path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z" />
  ) },
  { id: 'contacts', label: 'Contacts', stub: false, icon: (
    <><circle cx="9" cy="8" r="3" /><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" /><circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5.3 4 2.3 4 5.5" /></>
  ) },
  { id: 'performance', label: 'Global Performance', stub: false, icon: (
    <path d="M2 12h4l2-7 4 14 3-9 2 4h5" />
  ) },
  { id: 'playbook', label: 'Standard Operating Playbook', stub: true, icon: (
    <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z" /><path d="M4 19.5V4.5" /></>
  ) },
  { id: 'risk', label: 'Risk & Safety Audits', stub: true, icon: (
    <path d="M12 2l8 3.5v6c0 5-3.5 8-8 10.5-4.5-2.5-8-5.5-8-10.5v-6z" />
  ) },
  { id: 'admin', label: 'Admin Shell', stub: false, icon: (
    <><polyline points="4 6 10 12 4 18" /><line x1="12" y1="18" x2="20" y2="18" /></>
  ) },
]

function RailButton({ item, active, onClick }: { item: (typeof RAIL_ITEMS)[number]; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.label}
      style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'rgba(125,201,203,0.1)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: `1px solid ${active ? 'rgba(125,201,203,0.35)' : 'transparent'}`,
        color: active ? '#7DC9CB' : hover ? '#a1a1aa' : '#52525b',
        cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
      }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {item.icon}
      </svg>
    </button>
  )
}

const SIDEBAR_COLLAPSE_KEY = 'caye_founder_sidebar_collapsed'
const SIDEBAR_WIDTH_EXPANDED = 250
const SIDEBAR_WIDTH_COLLAPSED = 60

function businessInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
}

function SidebarToggle({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={collapsed ? 'Expand workspaces' : 'Collapse workspaces'}
      style={{
        width: 26, height: 26, borderRadius: 8, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: `1px solid ${hover ? CARD_BORDER : 'transparent'}`,
        color: hover ? '#a1a1aa' : '#52525b', cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
      }}
    >
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}
      >
        <polyline points="15 6 9 12 15 18" />
      </svg>
    </button>
  )
}

function StubConsole({ label }: { label: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', maxWidth: 360, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <CayeLoadingPulse label={`${label.toUpperCase()} · OFFLINE`} size={20} />
        <p style={{ fontSize: 13, color: '#71717a', lineHeight: 1.6 }}>
          Not built yet — placeholder rail destination. Use Caye Command for monitoring, source scheduling, and conversations for now.
        </p>
      </div>
    </div>
  )
}

// The founder's entire dashboard, one page — matches the reference
// mockup's structure (workspaces sidebar, top status bar, overview
// cards, calendar + conversations side by side). All data here is real
// (2026-07-02 data-wiring pass): workspaces list from workspace-context,
// bookings/conversations/escalations/spend/deployment status from
// /api/founder/command-overview. Replaces the old FounderHome + CayePanel
// slide-out entirely — no more panel-toggle model for founders.
const RAIL_IDS = RAIL_ITEMS.map((r) => r.id)

export default function FounderHome() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspace, workspaceId, workspaces } = useWorkspace()
  const [weekOffset, setWeekOffset] = useState(0)
  // Persisted so the founder's rail state (this list eats real vertical
  // space once there are more than a couple of workspaces) survives
  // reloads — same convention as lastActiveWorkspaceId in lib/supabase.ts.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'
  })
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? '1' : '0')
      return next
    })
  }
  const { data, refetch } = useCommandOverview(workspaceId, weekOffset)
  const [expanded, setExpanded] = useState<'calendar' | 'conversations' | 'cayeDirect' | null>(null)
  // Set by CommandCalendar on a booking click — jumps CommandConversations
  // to that customer's thread. Lives here since the two panels are
  // siblings with no coordination of their own.
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  // Read from the URL (?rail=), not local state — switching workspaces
  // navigates to a new /dashboard/[workspaceId] route, which remounts this
  // component (confirmed: even lifting this to a persistent layout-level
  // context still reset, so the whole [workspaceId] layout subtree remounts
  // on param change here). The URL survives any remount since it's re-read
  // fresh on every render.
  const rawRail = searchParams.get('rail')
  const railView: FounderRailId = (rawRail && RAIL_IDS.includes(rawRail as FounderRailId))
    ? (rawRail as FounderRailId)
    : 'dashboard'
  const setRailView = (id: FounderRailId) => {
    const params = new URLSearchParams(searchParams.toString())
    if (id === 'dashboard') params.delete('rail')
    else params.set('rail', id)
    const qs = params.toString()
    router.replace(`/dashboard/${workspaceId}${qs ? `?${qs}` : ''}`, { scroll: false })
  }
  const activeRailItem = RAIL_ITEMS.find((r) => r.id === railView)!

  return (
    <div className="caye-founder" style={{ display: 'flex', height: '100%', background: APP_BG, color: '#f4f4f5', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      {/* Thin dark scrollbars everywhere under the founder console — every
          scrollable panel (calendar, conversations, contacts, global
          performance, workspace list, Caye Direct) is a descendant of this
          one root, so one rule covers all of them instead of restyling
          each panel's overflow container individually. */}
      <style>{`
        .caye-founder * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
        .caye-founder *::-webkit-scrollbar { width: 6px; height: 6px; }
        .caye-founder *::-webkit-scrollbar-track { background: transparent; }
        .caye-founder *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .caye-founder *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
      `}</style>
      {/* ── Icon rail — Caye Command / Contacts are real, the rest are
          stub destinations matching how the reference mockup itself
          left them (unbuilt), per explicit direction to add the rail
          now with temp pages rather than wait for all of it. ── */}
      <nav style={{
        width: 64, flexShrink: 0, background: 'rgba(17,17,19,0.6)', borderRight: `1px solid ${CARD_BORDER}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px 0',
        ...GLASS,
      }}>
        <button
          onClick={() => setRailView('dashboard')}
          title="Caye Command"
          style={{
            width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: 'transparent',
            cursor: 'pointer',
          }}
        >
          <CayeMark size={28} />
        </button>
        {RAIL_ITEMS.filter((item) => item.id !== 'dashboard').map((item) => (
          <RailButton key={item.id} item={item} active={railView === item.id} onClick={() => setRailView(item.id)} />
        ))}
      </nav>

      {/* ── Workspaces sidebar (real cross-workspace list) ── */}
      <aside style={{
        width: sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        flexShrink: 0, borderRight: `1px solid ${CARD_BORDER}`,
        padding: sidebarCollapsed ? '16px 8px' : 16, overflowY: 'auto', overflowX: 'hidden',
        transition: 'width 0.2s ease, padding 0.2s ease',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          justifyContent: sidebarCollapsed ? 'center' : 'space-between',
        }}>
          {!sidebarCollapsed && (
            <span style={{
              fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', color: LABEL_COLOR,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              WORKSPACES
            </span>
          )}
          <SidebarToggle collapsed={sidebarCollapsed} onClick={toggleSidebarCollapsed} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sidebarCollapsed ? 8 : 4 }}>
          {workspaces.map((m) => {
            const active = m.workspace_id === workspaceId
            const goTo = () => router.push(
              `/dashboard/${m.workspace_id}${railView !== 'dashboard' ? `?rail=${railView}` : ''}`
            )
            if (sidebarCollapsed) {
              return (
                <button
                  key={m.workspace_id}
                  onClick={goTo}
                  title={`${m.customer.business_name} · ${STATUS_LABEL[m.customer.status]}`}
                  style={{
                    position: 'relative', width: 40, height: 40, margin: '0 auto', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 11, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(125,201,203,0.4)' : CARD_BORDER}`,
                    background: active ? 'rgba(125,201,203,0.1)' : 'rgba(255,255,255,0.03)',
                    fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    color: active ? '#7DC9CB' : '#a1a1aa',
                  }}
                >
                  {businessInitials(m.customer.business_name)}
                  <span aria-hidden style={{
                    position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: '50%',
                    background: STATUS_COLOR[m.customer.status], border: `2px solid ${APP_BG}`,
                  }} />
                </button>
              )
            }
            return (
              <button
                key={m.workspace_id}
                onClick={goTo}
                style={{
                  position: 'relative',
                  display: 'flex', flexDirection: 'column', gap: 6,
                  textAlign: 'left', border: `1px solid ${active ? '#2d2d34' : 'transparent'}`,
                  cursor: 'pointer', borderRadius: 12,
                  padding: '12px 14px 12px 17px',
                  background: active ? 'rgba(26,26,30,0.55)' : 'transparent',
                  ...(active ? GLASS : {}),
                }}
              >
                {active && (
                  <span aria-hidden style={{
                    position: 'absolute', left: 5, top: 10, bottom: 10, width: 3, borderRadius: 3,
                    background: GRADIENT,
                  }} />
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{
                    fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
                    color: active ? '#f4f4f5' : '#a1a1aa',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {m.customer.business_name}
                  </span>
                  <StatusPill status={m.customer.status} />
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Faint brand-gradient atmosphere, echoing the landing hero mesh
            without competing with the data-dense console below it. */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
          background:
            'radial-gradient(ellipse 900px 500px at 100% -10%, rgba(0,119,139,0.14), transparent 60%), ' +
            'radial-gradient(ellipse 700px 400px at -5% 110%, rgba(255,214,143,0.05), transparent 60%)',
        }} />
        {/* Top status bar — translucent so the atmosphere gradient behind
            it (the radial-gradient div above) shows through faintly. */}
        <div style={{
          padding: '16px 24px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          background: 'rgba(17,17,19,0.55)', ...GLASS,
        }}>
          {railView === 'performance' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Global Performance — All Workspaces</h1>
          ) : (
            <>
              <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>{workspace.business_name}</h1>
              <StatusPill status={workspace.status} />
            </>
          )}
        </div>

        {railView === 'performance' ? (
          <GlobalPerformance />
        ) : railView === 'contacts' ? (
          <ContactsPanel workspaceId={workspaceId} />
        ) : railView === 'admin' ? (
          <AdminShell />
        ) : activeRailItem.stub ? (
          <StubConsole label={activeRailItem.label} />
        ) : (
          <div style={{ flex: 1, overflowY: expanded ? 'hidden' : 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
            {/* Overview strip — hidden while a panel is expanded, so the
                expanded panel gets the whole page under the top bar. */}
            <div style={{ flexShrink: 0, display: expanded ? 'none' : 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <StatCard
                label="Deployment"
                value={data ? (data.caye_active ? 'Active & Chatting' : 'Paused') : '—'}
                valueColor={data?.caye_active ? '#34d399' : '#71717a'}
                action={data && (
                  <DeploymentToggle workspaceId={workspaceId} active={data.caye_active} onToggled={refetch} />
                )}
              />
              <StatCard label={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'} value={data ? String(data.bookings.length) : '—'} />
              <StatCard
                label="Needs review"
                value={data ? String(data.pending_escalation_count) : '—'}
                valueColor={data && data.pending_escalation_count > 0 ? '#fb7185' : '#f4f4f5'}
              />
              <StatCard label="7-day spend" value={data ? `$${data.total_cost_usd.toFixed(2)}` : '—'} />
            </div>

            {/* Calendar + Conversations. Either can expand to take the whole
                page — the other stays mounted but hidden, so its state
                (open thread, list scroll position) survives collapsing
                back rather than resetting. Caye Direct is hidden too while
                one of these is expanded, so the expanded panel truly owns
                the page. */}
            <div style={{
              display: expanded === 'cayeDirect' ? 'none' : 'grid',
              gridTemplateColumns: expanded ? '1fr' : '1fr 1fr',
              gap: 14,
              ...(expanded === 'calendar' || expanded === 'conversations'
                ? { flex: 1, minHeight: 0 }
                : { flexShrink: 0, height: 420 }),
            }}>
              <div style={{
                display: expanded === 'conversations' ? 'none' : 'block',
                position: 'relative',
                borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                <ExpandButton expanded={expanded === 'calendar'} onClick={() => setExpanded(expanded === 'calendar' ? null : 'calendar')} />
                {data && (
                  <CommandCalendar
                    bookings={data.bookings}
                    weekStart={data.week_start}
                    weekOffset={weekOffset}
                    onWeekOffsetChange={setWeekOffset}
                    onSelectConversation={setSelectedConversationId}
                  />
                )}
              </div>
              <div style={{
                display: expanded === 'calendar' ? 'none' : 'block',
                position: 'relative',
                borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                <ExpandButton expanded={expanded === 'conversations'} onClick={() => setExpanded(expanded === 'conversations' ? null : 'conversations')} />
                {data && (
                  <CommandConversations
                    workspaceId={workspaceId}
                    conversations={data.conversations}
                    selectedConversationId={selectedConversationId}
                    onSent={refetch}
                    compact={expanded !== 'conversations'}
                  />
                )}
              </div>
            </div>

            {/* Caye Direct — same back-office agent the founder already
                texts over WhatsApp, now with a web front end. Employee
                Performance Scorecard will take the other half of this
                row once built (next pass). */}
            <div style={{
              display: expanded === 'calendar' || expanded === 'conversations' ? 'none' : 'block',
              position: 'relative',
              ...(expanded === 'cayeDirect'
                ? { flex: 1, minHeight: 0 }
                : { flexShrink: 0, height: 380 }),
              borderRadius: 16, overflow: 'hidden', background: CARD_BG,
            }}>
              <ExpandButton expanded={expanded === 'cayeDirect'} onClick={() => setExpanded(expanded === 'cayeDirect' ? null : 'cayeDirect')} />
              <CayeDirect workspaceId={workspaceId} />
            </div>

            {!expanded && <ChannelsCard workspaceId={workspaceId} />}

            <div aria-hidden style={{ display: expanded ? 'none' : 'block', flexShrink: 0, height: 3, borderRadius: 3, background: GRADIENT, opacity: 0.4 }} />
          </div>
        )}
      </div>
    </div>
  )
}
