'use client'

import { useState, useEffect, useTransition, type ReactNode, type CSSProperties } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import { useWorkspacesActivity } from '@/lib/useWorkspacesActivity'
import { useWorkspaceChannels } from '@/lib/useWorkspaceChannels'
import type { FounderRailId } from '@/lib/types'
import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'
import CayeDirect from '@/components/dashboard/caye-direct/CayeDirect'
import ChannelsCard from '@/components/dashboard/founder-home/ChannelsCard'
import SettingsCard from '@/components/dashboard/founder-home/SettingsCard'
import GlobalPerformance from '@/components/dashboard/global-performance/GlobalPerformance'
import ContactsPanel from '@/components/dashboard/founder-home/ContactsPanel'
import AdminShell from '@/components/dashboard/admin-shell/AdminShell'
import CostPage from '@/components/dashboard/founder-home/CostPage'
import HealthPage from '@/components/dashboard/founder-home/HealthPage'
import ToolsPage from '@/components/dashboard/founder-home/ToolsPage'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { type CayeState } from '@/components/dashboard/founder-home/CayeCore'
import FounderBriefing from '@/components/dashboard/founder-home/FounderBriefing'
import BusinessPulse from '@/components/dashboard/founder-home/BusinessPulse'
import LiveActivity from '@/components/dashboard/founder-home/LiveActivity'
import CayeLog from '@/components/dashboard/founder-home/CayeLog'
import DecisionRequired from '@/components/dashboard/founder-home/DecisionRequired'
import TalkToCaye from '@/components/dashboard/founder-home/TalkToCaye'
import FounderProfile from '@/components/dashboard/founder-home/FounderProfile'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
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
const GRADIENT = 'linear-gradient(90deg, #0766A3, #4EBECE, #FFE4AF)'

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
  trial: '#FFE4AF',
  inactive: '#71717a',
  suspended: '#fb7185', // rose-400
}

function StatusPill({ status }: { status: CustomerStatus }) {
  return <Pill color={STATUS_COLOR[status]} label={STATUS_LABEL[status]} />
}

// Takes the expanded panel clean out of the page — over the icon rail,
// workspace sidebar and top status bar, not just the content column — so
// a thread/calendar/editor that expands gets the whole viewport instead of
// whatever's left under the chrome. Safe as position:fixed here: nothing
// between this and <html> sets a transform/filter/backdrop-filter/contain,
// so nothing steals its containing block. See FullscreenPanelHeader for the
// minimal chrome that replaces the status bar while a panel owns the page.
const FULLSCREEN_PANEL_STYLE: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200,
  display: 'flex', flexDirection: 'column',
  background: APP_BG,
}

function FullscreenPanelHeader({ title, workspaceName, onCollapse }: { title: string; workspaceName: string; onCollapse: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '13px 20px', borderBottom: `1px solid ${CARD_BORDER}`,
      background: 'rgba(17,17,19,0.55)', ...GLASS,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-display)', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{
          fontSize: 12, color: LABEL_COLOR, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {workspaceName}
        </span>
      </div>
      <button
        onClick={onCollapse}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Collapse (Esc)"
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
          border: 'none', cursor: 'pointer', borderRadius: 8,
          padding: '6px 10px 6px 8px', fontSize: 11.5, fontWeight: 600,
          background: hover ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.08)',
          color: '#a1a1aa', transition: 'background 0.15s ease',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
        </svg>
        Collapse
      </button>
    </div>
  )
}

function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={expanded ? 'Collapse' : 'Expand'}
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1,
        width: 26, height: 26, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.08)',
        color: '#a1a1aa', cursor: 'pointer',
        outline: 'none', boxShadow: 'none',
        transition: 'background 0.15s ease',
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

// Holds a panel's shape during a cold load. Previously these panels
// rendered nothing at all until data arrived, so the console collapsed to
// empty boxes and then reflowed — the single most jarring part of a
// workspace switch. Only reachable on a genuine first visit now that
// useCommandOverview seeds from its module cache; a return trip already
// has data on the first frame.
function PanelSkeleton() {
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, padding: 18, display: 'flex', flexDirection: 'column', gap: 11 }}>
      {[68, 45, 57, 39, 62, 48].map((w, i) => (
        <div key={i} style={{
          height: 13, width: `${w}%`, borderRadius: 6,
          background: 'rgba(255,255,255,0.06)',
          animation: 'caye-skeleton-pulse 1.5s ease-in-out infinite',
          animationDelay: `${i * 0.09}s`,
        }} />
      ))}
    </div>
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
  { id: 'cost', label: 'Cost', stub: false, icon: (
    <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5c0-1.4 1.2-2.5 2.5-2.5s2.5.8 2.5 2c0 3-5 2-5 5 0 1.2 1.2 2 2.5 2s2.5-1.1 2.5-2.5" /></>
  ) },
  { id: 'health', label: 'Health', stub: false, icon: (
    <path d="M12 20.5s-7-4.35-9.5-8.8C.9 8.4 2.4 5 5.8 5c1.9 0 3.4 1 6.2 4 2.8-3 4.3-4 6.2-4 3.4 0 4.9 3.4 3.3 6.7-2.5 4.45-9.5 8.8-9.5 8.8z" />
  ) },
  { id: 'tools', label: 'Tools', stub: false, icon: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.65 2.65a1.6 1.6 0 0 1-2.26-2.26L14.7 6.3z" />
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
        background: active ? 'rgba(78,190,206,0.14)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        color: active ? '#4EBECE' : hover ? '#a1a1aa' : '#52525b',
        cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease',
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

function businessInitials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
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
  const { data, revalidating, refetch } = useCommandOverview(workspaceId, weekOffset)
  const [isPending, startTransition] = useTransition()
  // Real signal for CayeCore's 'error' state — a channel that's simply
  // never been connected isn't an error (is_active false with no
  // needs_reauth), only one that WAS working and now needs reauth is.
  const { channels } = useWorkspaceChannels(workspaceId)
  const hasChannelError = channels ? Object.values(channels).some((c) => c?.needs_reauth === true) : false
  // Priority order: something broken outranks something merely pending,
  // which outranks "a fetch happens to be in flight" — a working-state
  // flicker shouldn't visually bump a real attention/error signal.
  const cayeState: CayeState = hasChannelError
    ? 'error'
    : data && data.pending_escalation_count > 0
    ? 'attention'
    : revalidating || isPending
    ? 'working'
    : 'idle'
  // The workspace we're navigating TO. Held so the sidebar highlight moves
  // on click instead of waiting for the route to commit — the click used to
  // register as nothing at all for a beat, which is most of what made
  // switching feel broken rather than merely slow.
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const { hasActivity } = useWorkspacesActivity(workspaces.map((m) => m.workspace_id), workspaceId)
  const [expanded, setExpanded] = useState<'calendar' | 'conversations' | 'cayeDirect' | 'settings' | null>(null)
  // Set by TalkToCaye's bottom composer — expands the real Caye Direct
  // panel and hands it the typed text to auto-send, so "Ask Caye
  // anything" is a launcher into the actual back-office thread rather
  // than a second, fake chat surface.
  const [talkToCayeDraft, setTalkToCayeDraft] = useState<string | null>(null)
  function handleTalkToCaye(text: string) {
    setExpanded('cayeDirect')
    setTalkToCayeDraft(text)
  }
  // A fullscreen panel has no visible close chrome besides its own
  // collapse button — Esc is the expected way out of a takeover like this.
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])
  // Set by CommandCalendar on a booking click — jumps CommandConversations
  // to that customer's thread. Lives here since the two panels are
  // siblings with no coordination of their own.
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  // The URL (?rail=) owns rail state ACROSS remounts — switching workspaces
  // navigates to a new /dashboard/[workspaceId] route and remounts this
  // component (confirmed: even lifting this to a persistent layout-level
  // context still reset, so the whole [workspaceId] layout subtree remounts
  // on param change). Local state owns it WITHIN a render pass, seeded from
  // the URL on mount so the remount behaviour is unchanged.
  //
  // The split exists because routing the click through router.replace and
  // waiting to read the param back meant every rail click paid a navigation
  // round trip before anything moved. Now the view swaps on the same tick
  // and the URL catches up behind it.
  const rawRail = searchParams.get('rail')
  const urlRail: FounderRailId = (rawRail && RAIL_IDS.includes(rawRail as FounderRailId))
    ? (rawRail as FounderRailId)
    : 'dashboard'
  const [railView, setRailViewState] = useState<FounderRailId>(urlRail)
  // Keeps browser back/forward working: an externally-driven URL change
  // pulls the view along with it. Setting the same value is a no-op render.
  //
  // Skipped mid-transition, otherwise clicking two rail items in quick
  // succession snaps back — the first click's URL lands while the second is
  // still in flight and would overwrite it. Once the last transition
  // settles this runs against the final URL, so it always converges.
  useEffect(() => {
    if (!isPending) setRailViewState(urlRail)
  }, [urlRail, isPending])

  const setRailView = (id: FounderRailId) => {
    setRailViewState(id)
    const params = new URLSearchParams(searchParams.toString())
    if (id === 'dashboard') params.delete('rail')
    else params.set('rail', id)
    const qs = params.toString()
    startTransition(() => {
      router.replace(`/dashboard/${workspaceId}${qs ? `?${qs}` : ''}`, { scroll: false })
    })
  }
  const activeRailItem = RAIL_ITEMS.find((r) => r.id === railView)!
  // Performance/Cost/Health are explicit "all workspaces" aggregates and
  // Admin Shell doesn't take a workspaceId at all (see AdminShell.tsx) —
  // on all four, clicking an entry in the workspace list changed the URL's
  // workspaceId param without changing anything on screen. That reads as a
  // scoping control that silently does nothing, which is worse than no
  // control at all. Command and Contacts are the only two views that
  // actually key off the selected workspace.
  const showWorkspaceSidebar = railView === 'dashboard' || railView === 'contacts'

  // Optimistic: highlight the workspace being navigated to, falling back to
  // the real one the moment the route commits.
  const highlightedWorkspaceId = (isPending && pendingWorkspaceId) || workspaceId

  return (
    <div className="caye-founder" style={{ display: 'flex', height: '100%', background: APP_BG, color: '#f4f4f5', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      {/* Thin dark scrollbars everywhere under the founder console — every
          scrollable panel (calendar, conversations, contacts, global
          performance, workspace list, Caye Direct) is a descendant of this
          one root, so one rule covers all of them instead of restyling
          each panel's overflow container individually. */}
      <style>{`
        /* Rail/workspace view swap. Short and translation-light on purpose:
           this fires on every navigation, and anything slower than ~200ms
           or moving more than a few px starts to feel like waiting. */
        @keyframes caye-view-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes caye-skeleton-pulse {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 0.75; }
        }
        @keyframes caye-progress-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(360%); }
        }
        /* Navigation in flight. Holds the OLD view on screen, slightly
           receded, instead of blanking it — the switch reads as a
           transition rather than a teardown. */
        .caye-nav-pending { opacity: 0.62; transition: opacity 0.16s ease; }
        .caye-nav-idle { opacity: 1; transition: opacity 0.16s ease; }
        @media (prefers-reduced-motion: reduce) {
          .caye-view-swap { animation: none !important; }
          .caye-nav-pending, .caye-nav-idle { transition: none; }
        }
        .caye-founder * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
        .caye-founder *::-webkit-scrollbar { width: 6px; height: 6px; }
        .caye-founder *::-webkit-scrollbar-track { background: transparent; }
        .caye-founder *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .caye-founder *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

        /* Responsive — this console had no breakpoints at all before this
           pass (fixed 64px rail + up to 250px sidebar + hard-coded 2-col
           grids). These three breakpoints stack the panel grids and shed
           the workspace sidebar rather than shrinking a desktop layout
           in place. */
        @media (max-width: 1100px) {
          .caye-stack-grid { grid-template-columns: 1fr !important; }
          .caye-cal-conv-grid {
            grid-template-columns: 1fr !important;
            height: auto !important;
            grid-auto-rows: 380px !important;
          }
        }
        @media (max-width: 780px) {
          .caye-rail { width: 52px !important; }
          .caye-workspace-sidebar { display: none !important; }
        }
      `}</style>
      {/* ── Icon rail — Caye Command / Contacts are real, the rest are
          stub destinations matching how the reference mockup itself
          left them (unbuilt), per explicit direction to add the rail
          now with temp pages rather than wait for all of it. ── */}
      <nav className="caye-rail" style={{
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
        <div style={{ marginTop: 'auto' }}>
          <FounderProfile />
        </div>
      </nav>

      {/* ── Workspaces sidebar — only on the two views it actually scopes,
          see showWorkspaceSidebar above ── */}
      {showWorkspaceSidebar && (
      <aside className="caye-workspace-sidebar" style={{
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
            const active = m.workspace_id === highlightedWorkspaceId
            const goTo = () => {
              if (m.workspace_id === workspaceId) return
              setPendingWorkspaceId(m.workspace_id)
              startTransition(() => {
                router.push(
                  `/dashboard/${m.workspace_id}${railView !== 'dashboard' ? `?rail=${railView}` : ''}`
                )
              })
            }
            if (sidebarCollapsed) {
              return (
                <button
                  key={m.workspace_id}
                  onClick={goTo}
                  title={`${m.customer.business_name ?? 'New signup'} · ${STATUS_LABEL[m.customer.status]}`}
                  style={{
                    position: 'relative', width: 40, height: 40, margin: '0 auto', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 11, cursor: 'pointer',
                    background: active ? 'rgba(78,190,206,0.16)' : 'rgba(255,255,255,0.045)',
                    fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    color: active ? '#4EBECE' : '#a1a1aa',
                  }}
                >
                  {businessInitials(m.customer.business_name)}
                  <span aria-hidden style={{
                    position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: '50%',
                    background: STATUS_COLOR[m.customer.status], border: `2px solid ${APP_BG}`,
                  }} />
                  {hasActivity(m.workspace_id) && (
                    <span aria-hidden title="New activity" style={{
                      position: 'absolute', bottom: -2, right: -2, width: 8, height: 8, borderRadius: '50%',
                      background: '#4EBECE', border: `2px solid ${APP_BG}`,
                      boxShadow: '0 0 0 2px rgba(78,190,206,0.25)',
                    }} />
                  )}
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
                  textAlign: 'left',
                  cursor: 'pointer', borderRadius: 12,
                  padding: '12px 14px',
                  background: active ? 'rgba(78,190,206,0.09)' : 'transparent',
                  ...(active ? GLASS : {}),
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
                    fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
                    color: active ? '#f4f4f5' : '#a1a1aa',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {hasActivity(m.workspace_id) && (
                      <span aria-hidden title="New activity" style={{
                        width: 6, height: 6, borderRadius: '50%', background: '#4EBECE', flexShrink: 0,
                        boxShadow: '0 0 0 2px rgba(78,190,206,0.25)',
                      }} />
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {m.customer.business_name ?? 'New signup'}
                    </span>
                  </span>
                  <StatusPill status={m.customer.status} />
                </div>
              </button>
            )
          })}
        </div>
      </aside>
      )}

      {/* ── Main ── */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Faint brand-gradient atmosphere, echoing the landing hero mesh
            without competing with the data-dense console below it. */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
          background:
            'radial-gradient(ellipse 900px 500px at 100% -10%, rgba(7,102,163,0.14), transparent 60%), ' +
            'radial-gradient(ellipse 700px 400px at -5% 110%, rgba(255,228,175,0.05), transparent 60%)',
        }} />
        {/* Top status bar — translucent so the atmosphere gradient behind
            it (the radial-gradient div above) shows through faintly. */}
        <div style={{
          position: 'relative',
          padding: '16px 24px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          background: 'rgba(17,17,19,0.55)', ...GLASS,
        }}>
          {/* Work-in-progress line, sitting on the bottom border. Replaces
              the old signal for "something is loading", which was the
              content disappearing. */}
          {(isPending || revalidating) && (
            <div aria-hidden style={{
              position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, overflow: 'hidden',
            }}>
              <div style={{
                width: '38%', height: '100%', borderRadius: 2, background: GRADIENT,
                animation: 'caye-progress-slide 0.9s ease-in-out infinite',
              }} />
            </div>
          )}
          {railView === 'performance' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Global Performance — All Workspaces</h1>
          ) : railView === 'cost' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Cost — All Workspaces</h1>
          ) : railView === 'health' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Health — Caye System Status</h1>
          ) : railView === 'tools' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Tools — Caye's Capabilities</h1>
          ) : railView === 'admin' ? (
            <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>Admin Shell — Back Office</h1>
          ) : (
            <>
              <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>{workspace.business_name ?? 'New signup'}</h1>
              <StatusPill status={workspace.status} />
            </>
          )}
        </div>

        {/* Keyed on railView so each destination animates in on arrival.
            Every rail page roots at flex:1, so this wrapper reproduces the
            flex column they were direct children of. */}
        <div
          key={railView}
          className={`caye-view-swap ${isPending ? 'caye-nav-pending' : 'caye-nav-idle'}`}
          style={{
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            animation: 'caye-view-in 0.2s ease-out',
          }}
        >
        {railView === 'performance' ? (
          <GlobalPerformance />
        ) : railView === 'contacts' ? (
          <ContactsPanel workspaceId={workspaceId} />
        ) : railView === 'admin' ? (
          <AdminShell />
        ) : railView === 'cost' ? (
          <CostPage />
        ) : railView === 'health' ? (
          <HealthPage />
        ) : railView === 'tools' ? (
          <ToolsPage />
        ) : activeRailItem.stub ? (
          <StubConsole label={activeRailItem.label} />
        ) : (
          <div style={{ flex: 1, overflowY: expanded ? 'hidden' : 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
            {/* Hero — greeting + the living Caye Core, real state
                (working/attention/error) driven off command-overview and
                channel health. Hidden while a panel is expanded. */}
            {!expanded && (
              <FounderBriefing data={data} workspaceName={workspace.business_name ?? 'New signup'} state={cayeState} />
            )}

            {/* Decision Required — renders nothing today. No backend
                concept of a human-approval queue exists yet (see
                DecisionRequired's doc comment); this is the wiring point
                for when one does, not a placeholder with fake data. */}
            {!expanded && <DecisionRequired decisions={[]} />}

            {/* Business Pulse — same 4 real numbers the old stat-card grid
                showed, now a compact horizontal strip instead of 4 boxed
                cards. */}
            {!expanded && (
              <BusinessPulse
                data={data}
                workspaceId={workspaceId}
                weekLabel={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'}
                onDeploymentToggled={refetch}
              />
            )}

            {/* Live + Caye's Log — "is she working, what has she done" at
                two depths off the same workspace_events read. Hidden
                alongside the rest of the glance view while a panel is
                expanded. */}
            <div className="caye-stack-grid" style={{
              display: expanded ? 'none' : 'grid',
              gridTemplateColumns: '1fr 1fr', gap: 14, flexShrink: 0,
            }}>
              <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${CARD_BORDER}`, padding: '14px 16px', height: 260, overflowY: 'auto' }}>
                <LiveActivity workspaceId={workspaceId} />
              </div>
              <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${CARD_BORDER}`, padding: '14px 16px', height: 260 }}>
                <CayeLog workspaceId={workspaceId} />
              </div>
            </div>

            {/* Calendar + Conversations. Either can expand to take the whole
                page — the other stays mounted but hidden, so its state
                (open thread, list scroll position) survives collapsing
                back rather than resetting. Caye Direct is hidden too while
                one of these is expanded, so the expanded panel truly owns
                the page. */}
            <div className="caye-cal-conv-grid" style={{
              display: expanded === 'cayeDirect' || expanded === 'settings' ? 'none' : 'grid',
              gridTemplateColumns: expanded ? '1fr' : '1fr 1fr',
              gap: 14,
              ...(expanded === 'calendar' || expanded === 'conversations'
                ? { flex: 1, minHeight: 0 }
                : { flexShrink: 0, height: 420 }),
            }}>
              <div style={expanded === 'conversations' ? FULLSCREEN_PANEL_STYLE : {
                display: expanded === 'calendar' ? 'none' : 'block',
                position: 'relative',
                borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                {expanded === 'conversations' ? (
                  <FullscreenPanelHeader title="Conversations" workspaceName={workspace.business_name ?? 'New signup'} onCollapse={() => setExpanded(null)} />
                ) : (
                  <ExpandButton expanded={false} onClick={() => setExpanded('conversations')} />
                )}
                <div style={expanded === 'conversations' ? { flex: 1, minHeight: 0 } : undefined}>
                  {data ? (
                    <CommandConversations
                      workspaceId={workspaceId}
                      selectedConversationId={selectedConversationId}
                      onSent={refetch}
                      compact={expanded !== 'conversations'}
                      onRequestExpand={() => setExpanded('conversations')}
                    />
                  ) : <PanelSkeleton />}
                </div>
              </div>
              <div style={expanded === 'calendar' ? FULLSCREEN_PANEL_STYLE : {
                display: expanded === 'conversations' ? 'none' : 'block',
                position: 'relative',
                borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                {expanded === 'calendar' ? (
                  <FullscreenPanelHeader title="Calendar" workspaceName={workspace.business_name ?? 'New signup'} onCollapse={() => setExpanded(null)} />
                ) : (
                  <ExpandButton expanded={false} onClick={() => setExpanded('calendar')} />
                )}
                <div style={expanded === 'calendar' ? { flex: 1, minHeight: 0 } : undefined}>
                  {data ? (
                    <CommandCalendar
                      workspaceId={workspaceId}
                      bookings={data.bookings}
                      weekStart={data.week_start}
                      weekOffset={weekOffset}
                      onWeekOffsetChange={setWeekOffset}
                      onSelectConversation={setSelectedConversationId}
                    />
                  ) : <PanelSkeleton />}
                </div>
              </div>
            </div>

            {/* Caye Direct — same back-office agent the founder already
                texts over WhatsApp, now with a web front end. Employee
                Performance Scorecard will take the other half of this
                row once built (next pass). */}
            <div style={expanded === 'cayeDirect' ? FULLSCREEN_PANEL_STYLE : {
              display: expanded === 'calendar' || expanded === 'conversations' || expanded === 'settings' ? 'none' : 'block',
              position: 'relative',
              flexShrink: 0, height: 480,
              borderRadius: 16, overflow: 'hidden', background: CARD_BG,
            }}>
              {expanded === 'cayeDirect' ? (
                <FullscreenPanelHeader title="Caye Direct" workspaceName={workspace.business_name ?? 'New signup'} onCollapse={() => setExpanded(null)} />
              ) : (
                <ExpandButton expanded={false} onClick={() => setExpanded('cayeDirect')} />
              )}
              <div style={expanded === 'cayeDirect' ? { flex: 1, minHeight: 0 } : { height: '100%' }}>
                <CayeDirect
                  workspaceId={workspaceId}
                  initialMessage={talkToCayeDraft}
                  onInitialMessageSent={() => setTalkToCayeDraft(null)}
                />
              </div>
            </div>

            {/* Channels + Settings — paired row, same weight as Calendar/
                Conversations above. Settings can expand to a full-page
                editor (system prompt, voice profile); Channels doesn't
                need that treatment (its content is already short). */}
            <div className="caye-stack-grid" style={{
              display: expanded === 'calendar' || expanded === 'conversations' || expanded === 'cayeDirect' ? 'none' : 'grid',
              gridTemplateColumns: expanded === 'settings' ? '1fr' : '1fr 1fr',
              gap: 14,
              ...(expanded === 'settings' ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
            }}>
              {expanded !== 'settings' && <ChannelsCard workspaceId={workspaceId} />}
              <div style={expanded === 'settings' ? FULLSCREEN_PANEL_STYLE : {
                display: 'flex', flexDirection: 'column', position: 'relative',
              }}>
                {expanded === 'settings' ? (
                  <FullscreenPanelHeader title="Settings" workspaceName={workspace.business_name ?? 'New signup'} onCollapse={() => setExpanded(null)} />
                ) : (
                  <ExpandButton expanded={false} onClick={() => setExpanded('settings')} />
                )}
                <div style={expanded === 'settings' ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
                  <SettingsCard workspaceId={workspaceId} compact={expanded !== 'settings'} />
                </div>
              </div>
            </div>

            <div aria-hidden style={{ display: expanded ? 'none' : 'block', flexShrink: 0, height: 3, borderRadius: 3, background: GRADIENT, opacity: 0.4 }} />
          </div>
        )}
        </div>

        {/* Persistent across every rail tab — hidden only while a panel
            has taken over the full viewport (it'd render underneath the
            fullscreen overlay anyway). Launches the real Caye Direct
            thread rather than being its own chat surface. */}
        {!expanded && (
          <div style={{ flexShrink: 0, padding: '0 20px 16px' }}>
            <TalkToCaye onSend={handleTalkToCaye} />
          </div>
        )}
      </div>
    </div>
  )
}
