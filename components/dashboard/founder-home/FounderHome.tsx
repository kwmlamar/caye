'use client'

import { useState, useEffect, useTransition, type ReactNode, type CSSProperties } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import { useWorkspacesActivity } from '@/lib/useWorkspacesActivity'
import { useWorkspaceChannels } from '@/lib/useWorkspaceChannels'
import { useTodayStats } from '@/lib/useTodayStats'
import type { FounderRailId } from '@/lib/types'
import CayeDirect from '@/components/dashboard/caye-direct/CayeDirect'
import { type CayeState } from './CayeCore'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import FounderBriefing from './FounderBriefing'
import BusinessPulse from './BusinessPulse'
import LiveActivity from './LiveActivity'
import CayeLog from './CayeLog'
import InboxPage from './InboxPage'
import PeoplePage from './PeoplePage'
import WorkPage from './WorkPage'
import MemoryPage from './MemoryPage'
import SettingsPage from './SettingsPage'
import TalkToCaye from './TalkToCaye'
import CayeLauncher from './CayeLauncher'
import FounderProfile from './FounderProfile'
import { ENV_BG, AQUA, GRADIENT, glass, paneShadowSoft, focusResetCss } from '../surface'

// 2026-08-13 visual pass: moved from "cards on a black page" toward one
// continuous environment. Hard 1px outlines are the exception now, not
// the default — see surface.ts for the shared hierarchy this draws from.
const GLASS: CSSProperties = glass(0.045)

// The one remaining fullscreen takeover — Caye Direct's full history,
// opened from the Talk to Caye composer. Calendar/Conversations/Settings
// used to have their own in-place expand-to-fullscreen (see git history on
// this branch before the IA rework) — that machinery is gone now that
// those are dedicated pages (Work/Inbox/Settings) with their own room to
// breathe, not compact panels fighting for space on Home.
const FULLSCREEN_PANEL_STYLE: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200,
  display: 'flex', flexDirection: 'column',
  background: ENV_BG,
}

function FullscreenPanelHeader({ title, workspaceName, onCollapse }: { title: string; workspaceName: string; onCollapse: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '13px 20px', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)',
      background: 'rgba(17,17,19,0.55)', ...GLASS,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-display)', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#71717a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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

// ── Icon rail — five real destinations, no stubs. Configuration
// (channels, voice, cost, health, tools, admin) lives under Settings,
// pinned near the bottom with the founder's own identity — not parallel
// nav icons competing with the daily-use surfaces above them.
type RailId = FounderRailId

const RAIL_ITEMS: { id: RailId; label: string; icon: ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" /> },
  { id: 'inbox', label: 'Inbox', icon: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></> },
  { id: 'people', label: 'People', icon: (
    <><circle cx="9" cy="8" r="3" /><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" /><circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5.3 4 2.3 4 5.5" /></>
  ) },
  { id: 'work', label: 'Work', icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></> },
  { id: 'memory', label: 'Memory', icon: <><path d="M12 4.5c-2-1.6-5-1.6-7 0v13c2-1.6 5-1.6 7 0" /><path d="M12 4.5c2-1.6 5-1.6 7 0v13c-2-1.6-5-1.6-7 0" /></> },
]

function RailButton({ item, active, onClick }: { item: (typeof RAIL_ITEMS)[number]; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'rgba(78,190,206,0.09)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        boxShadow: active ? '0 0 18px rgba(78,190,206,0.22)' : 'none',
        color: active ? '#7DD8E0' : hover ? '#a1a1aa' : '#52525b',
        cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease, box-shadow 0.2s ease',
      }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {item.icon}
      </svg>
    </button>
  )
}

const SETTINGS_ICON = (
  <><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" />
    <line x1="4" y1="18" x2="20" y2="18" /><circle cx="9" cy="18" r="2" /></>
)

const RAIL_IDS: RailId[] = [...RAIL_ITEMS.map((r) => r.id), 'settings']

// The founder's entire briefing, one page. Home stays deliberately short
// (hero, attention, business pulse, working-now, a short log) — the
// calendar, the full conversation list, contacts, channels/voice/cost/
// health/tools/admin, and the complete activity history all moved to
// their own pages (Inbox/People/Work/Memory/Settings) rather than being
// destroyed. See the redesign audit for the reasoning per section.
export default function FounderHome() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspace, workspaceId, workspaces } = useWorkspace()
  const [weekOffset, setWeekOffset] = useState(0)
  const { data, revalidating, refetch } = useCommandOverview(workspaceId, weekOffset)
  const today = useTodayStats(workspaceId)
  const [isPending, startTransition] = useTransition()
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const { hasActivity } = useWorkspacesActivity(workspaces.map((m) => m.workspace_id), workspaceId)
  const { channels } = useWorkspaceChannels(workspaceId)
  const hasChannelError = channels ? Object.values(channels).some((c) => c?.needs_reauth === true) : false
  const cayeState: CayeState = hasChannelError
    ? 'error'
    : data && data.pending_escalation_count > 0
    ? 'attention'
    : revalidating || isPending
    ? 'working'
    : 'idle'

  const [expanded, setExpanded] = useState<'cayeDirect' | null>(null)
  const [talkToCayeDraft, setTalkToCayeDraft] = useState<string | null>(null)
  function handleTalkToCaye(text: string) {
    setExpanded('cayeDirect')
    setTalkToCayeDraft(text)
  }

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  function goToConversation(conversationId: string | null) {
    setSelectedConversationId(conversationId)
    setRailView('inbox')
  }

  const rawRail = searchParams.get('rail')
  const urlRail: FounderRailId = (rawRail && RAIL_IDS.includes(rawRail as FounderRailId))
    ? (rawRail as FounderRailId)
    : 'home'
  const [railView, setRailViewState] = useState<FounderRailId>(urlRail)
  useEffect(() => {
    if (!isPending) setRailViewState(urlRail)
  }, [urlRail, isPending])

  const setRailView = (id: FounderRailId) => {
    setRailViewState(id)
    const params = new URLSearchParams(searchParams.toString())
    if (id === 'home') params.delete('rail')
    else params.set('rail', id)
    const qs = params.toString()
    startTransition(() => {
      router.replace(`/dashboard/${workspaceId}${qs ? `?${qs}` : ''}`, { scroll: false })
    })
  }

  function goToWorkspace(id: string) {
    if (id === workspaceId) return
    setPendingWorkspaceId(id)
    startTransition(() => {
      router.push(`/dashboard/${id}${railView !== 'home' ? `?rail=${railView}` : ''}`)
    })
  }
  const highlightedWorkspaceId = (isPending && pendingWorkspaceId) || workspaceId

  return (
    <div className="caye-founder" style={{ display: 'flex', height: '100%', background: ENV_BG, color: '#f4f4f5', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      <style>{`
        @keyframes caye-view-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes caye-progress-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(360%); }
        }
        @keyframes caye-popover-in {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes caye-resolve-out {
          to { opacity: 0; transform: scale(0.97); }
        }
        .caye-nav-pending { opacity: 0.62; transition: opacity 0.16s ease; }
        .caye-nav-idle { opacity: 1; transition: opacity 0.16s ease; }
        .caye-activity-row { transition: background 0.15s ease; }
        .caye-activity-row:hover { background: rgba(255,255,255,0.035); }
        @media (prefers-reduced-motion: reduce) {
          .caye-view-swap { animation: none !important; }
          .caye-nav-pending, .caye-nav-idle { transition: none; }
          [style*="caye-popover-in"], [style*="caye-view-in"], [style*="caye-resolve-out"] { animation: none !important; }
        }
        .caye-founder * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
        .caye-founder *::-webkit-scrollbar { width: 6px; height: 6px; }
        .caye-founder *::-webkit-scrollbar-track { background: transparent; }
        .caye-founder *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .caye-founder *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        ${focusResetCss}

        /* Responsive. Desktop: hero side-by-side (text | orb). Below
           1100px the orb block visually leads (still text-first in the
           DOM/for assistive tech) so a glance at a laptop or tablet still
           sees Caye's state before the paragraph. Panel grids stack. */
        @media (max-width: 1100px) {
          .caye-hero { flex-direction: column; text-align: center; gap: 20px; }
          .caye-hero-orb { order: -1; }
          .caye-hero-text { align-items: center; text-align: center; }
          .caye-hero-text p { max-width: none !important; }
          .caye-stack-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 780px) {
          .caye-rail { width: 52px !important; }
        }
        @media (max-width: 560px) {
          .caye-hero { padding-top: 20px !important; }
        }
      `}</style>

      {/* ── Icon rail — five destinations, Settings + identity pinned to
          the bottom. No workspace initials here anymore; see header. ── */}
      <nav className="caye-rail" style={{
        width: 64, flexShrink: 0, background: 'rgba(17,17,19,0.5)',
        boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.035)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px 0',
        ...GLASS,
      }}>
        {RAIL_ITEMS.map((item) => (
          <RailButton key={item.id} item={item} active={railView === item.id} onClick={() => setRailView(item.id)} />
        ))}
        <div style={{ flex: 1 }} />
        <RailButton
          item={{ id: 'settings', label: 'Settings', icon: SETTINGS_ICON }}
          active={railView === 'settings'}
          onClick={() => setRailView('settings')}
        />
        <FounderProfile />
      </nav>

      {/* ── Main ── */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Atmosphere — the environment should read as "Caye's light
            falling on the room," not a designed gradient. Third glow is
            loosely anchored near where the orb sits in the hero; the rest
            is deliberately faint enough to be subconscious. */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
          background:
            'radial-gradient(ellipse 900px 500px at 100% -10%, rgba(7,102,163,0.13), transparent 60%), ' +
            'radial-gradient(ellipse 620px 480px at 78% 20%, rgba(78,190,206,0.06), transparent 65%), ' +
            'radial-gradient(ellipse 500px 380px at 82% 16%, rgba(255,228,175,0.035), transparent 60%), ' +
            'radial-gradient(ellipse 700px 400px at -5% 110%, rgba(255,228,175,0.04), transparent 60%)',
        }} />
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1, opacity: 0.025,
          mixBlendMode: 'overlay',
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }} />

        {/* Header — logo + current workspace + status, click to switch.
            Replaces both the old rail's logo button and the old top
            status bar's plain workspace name. Separation from content
            below is tonal (glass) + a hairline inner shadow, not a border.
            zIndex is load-bearing, not decorative: backdrop-filter (in
            GLASS) makes this element its own stacking context, but
            without an explicit z-index that context still paints in DOM
            order among siblings — meaning the view-swap content div right
            after it (later in the DOM) was painting OVER the workspace
            popover despite the popover's own z-index:100, since that
            z-index only wins comparisons *inside* this header's stacking
            context, not against the header's siblings. That was the real
            "text bleeds through the popover" bug — not a transparency
            problem, a paint-order one. Any opacity fix alone couldn't
            have solved it. */}
        <div style={{
          position: 'relative', zIndex: 20, padding: '10px 20px',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.035)',
          display: 'flex', alignItems: 'center', flexShrink: 0,
          background: 'rgba(17,17,19,0.4)', ...GLASS,
        }}>
          {(isPending || revalidating) && (
            <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, overflow: 'hidden' }}>
              <div style={{ width: '38%', height: '100%', borderRadius: 2, background: GRADIENT, animation: 'caye-progress-slide 0.9s ease-in-out infinite' }} />
            </div>
          )}
          <WorkspaceSwitcher
            businessName={workspace.business_name ?? 'New signup'}
            status={workspace.status}
            workspaces={workspaces}
            activeWorkspaceId={highlightedWorkspaceId}
            onSelect={goToWorkspace}
            hasActivity={hasActivity}
          />
        </div>

        <div
          key={railView}
          className={`caye-view-swap ${isPending ? 'caye-nav-pending' : 'caye-nav-idle'}`}
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', animation: 'caye-view-in 0.2s ease-out' }}
        >
          {railView === 'inbox' ? (
            <InboxPage workspaceId={workspaceId} selectedConversationId={selectedConversationId} onSent={refetch} />
          ) : railView === 'people' ? (
            <PeoplePage workspaceId={workspaceId} onReviewConversation={goToConversation} />
          ) : railView === 'work' ? (
            <WorkPage
              workspaceId={workspaceId}
              data={data}
              weekOffset={weekOffset}
              onWeekOffsetChange={setWeekOffset}
              onSelectConversation={goToConversation}
            />
          ) : railView === 'memory' ? (
            <MemoryPage workspaceId={workspaceId} />
          ) : railView === 'settings' ? (
            <SettingsPage workspaceId={workspaceId} />
          ) : (
            // ── Home ── Level 1 (hero + attention), Level 2 (business
            // pulse + working now), Level 3 (short log). Deliberately
            // shorter than the old dashboard — substantial negative
            // space is the point, not a gap to be filled.
            // paddingBottom clears the floating global composer (~70px
            // tall, anchored to Main's bottom) so the last row of content
            // can still scroll fully into view above it.
            <div className="caye-hero-wrap" style={{ flex: 1, overflowY: 'auto', padding: '8px 32px 96px', display: 'flex', flexDirection: 'column', gap: 36, minHeight: 0 }}>
              <FounderBriefing
                data={data}
                today={today}
                workspaceId={workspaceId}
                workspaceName={workspace.business_name ?? 'New signup'}
                state={cayeState}
                onReviewAttention={goToConversation}
                onDeploymentToggled={refetch}
              />

              <BusinessPulse data={data} today={today} weekLabel={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'} />

              <div className="caye-stack-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 36 }}>
                <LiveActivity workspaceId={workspaceId} />
                <CayeLog workspaceId={workspaceId} limit={6} onViewAll={() => setRailView('work')} />
              </div>
            </div>
          )}
        </div>

        {expanded === 'cayeDirect' && (
          <div style={FULLSCREEN_PANEL_STYLE}>
            <FullscreenPanelHeader title="Caye Direct" workspaceName={workspace.business_name ?? 'New signup'} onCollapse={() => setExpanded(null)} />
            <div style={{ flex: 1, minHeight: 0 }}>
              <CayeDirect
                workspaceId={workspaceId}
                initialMessage={talkToCayeDraft}
                onInitialMessageSent={() => setTalkToCayeDraft(null)}
              />
            </div>
          </div>
        )}

        {!expanded && (
          railView === 'inbox' ? (
            // On Inbox, replying to the customer is the primary action —
            // a second full-width "Ask Caye anything" bar at the same
            // visual weight was directly competing with (and overlapping)
            // the conversation reply composer. CayeLauncher owns its own
            // bottom-right positioning, stacked above the reply
            // composer's vertical span rather than beside it — see its
            // own doc comment for why beside-it was rejected (the list/
            // thread split is user-resizable, so a fixed side offset
            // risked drifting into the reply composer at some ratios).
            <CayeLauncher onSend={handleTalkToCaye} onOpenHistory={() => setExpanded('cayeDirect')} />
          ) : (
            // Root-caused (2026-08-14): making this wrapper's background
            // transparent was NOT enough, because transparency was never
            // the actual bug. This used to be a normal flex-flow sibling
            // of the view-swap content div (flexShrink:0) — meaning it
            // consumed its OWN reserved row at the bottom of Main.
            // Nothing was ever painted in that row except padding, so
            // what looked like "a dark footer" was genuinely empty
            // canvas (Main/root's ENV_BG), not a leftover background
            // color — the content area literally stopped short of it.
            // Fixed by taking this out of flex flow entirely: absolutely
            // positioned, anchored to the bottom of Main, so the
            // view-swap div above naturally expands to fill the space
            // this used to reserve, and page content can now genuinely
            // scroll underneath this floating region. pointer-events:none
            // on this wrapper (empty margin around the pill never blocks
            // a click/scroll on content behind it); TalkToCaye's own root
            // re-enables pointer-events:auto.
            <div style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 15,
              padding: '0 20px 14px', background: 'transparent', pointerEvents: 'none',
            }}>
              <TalkToCaye onSend={handleTalkToCaye} onOpenHistory={() => setExpanded('cayeDirect')} />
            </div>
          )
        )}
      </div>
    </div>
  )
}
