'use client'

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'
import CayeDirect from '@/components/dashboard/caye-direct/CayeDirect'
import type { CustomerStatus } from '@/types/database'

// Tokens lifted directly from Sandbox/caye-command (the reference
// mockup) via computed styles — bg-[#09090b]/[#121214]/border-[#1f1f23],
// font-mono labels, font-display (Space Grotesk) values. The one thing
// NOT copied from the mockup is its cyan/purple/rose accent gradient —
// that's replaced with our own teal/gold mesh palette (matches the
// landing hero + CayeMark orb), per the earlier gradient-consistency
// decision. 2026-07-02 theme pass.
const APP_BG = '#09090b'
const CARD_BG = '#121214'
const CARD_BORDER = '#1f1f23'
const LABEL_COLOR = '#71717a' // zinc-500
const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

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
  const color = STATUS_COLOR[status]
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
      color, background: `${color}1a`, border: `1px solid ${color}33`,
      borderRadius: 999, padding: '2px 8px', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={expanded ? 'Collapse' : 'Expand'}
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1,
        width: 26, height: 26, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,0.06)', border: `1px solid ${CARD_BORDER}`,
        color: '#a1a1aa', cursor: 'pointer',
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

function StatCard({ label, value, valueColor = '#f4f4f5' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, color: valueColor, marginTop: 6 }}>
        {value}
      </div>
    </div>
  )
}

// ── Icon rail ────────────────────────────────────────────────────────
// Plain inline SVGs rather than a new icon-library import — avoids
// guessing at export names for a package whose install layout couldn't
// be confirmed in this pass.
type RailId = 'dashboard' | 'placements' | 'performance' | 'playbook' | 'risk' | 'admin'

const RAIL_ITEMS: { id: RailId; label: string; icon: ReactNode; stub: boolean }[] = [
  { id: 'dashboard', label: 'Caye Command', stub: false, icon: (
    <path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z" />
  ) },
  { id: 'placements', label: 'Placements', stub: false, icon: (
    <><circle cx="9" cy="8" r="3" /><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" /><circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5.3 4 2.3 4 5.5" /></>
  ) },
  { id: 'performance', label: 'Global Performance', stub: true, icon: (
    <path d="M2 12h4l2-7 4 14 3-9 2 4h5" />
  ) },
  { id: 'playbook', label: 'Standard Operating Playbook', stub: true, icon: (
    <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z" /><path d="M4 19.5V4.5" /></>
  ) },
  { id: 'risk', label: 'Risk & Safety Audits', stub: true, icon: (
    <path d="M12 2l8 3.5v6c0 5-3.5 8-8 10.5-4.5-2.5-8-5.5-8-10.5v-6z" />
  ) },
  { id: 'admin', label: 'Admin Shell', stub: true, icon: (
    <><polyline points="4 6 10 12 4 18" /><line x1="12" y1="18" x2="20" y2="18" /></>
  ) },
]

function RailButton({ item, active, onClick }: { item: (typeof RAIL_ITEMS)[number]; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={item.label}
      style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: `1px solid ${active ? '#2d2d34' : 'transparent'}`,
        color: active ? '#7DC9CB' : '#52525b',
        cursor: 'pointer',
      }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {item.icon}
      </svg>
    </button>
  )
}

function StubConsole({ label }: { label: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: '#52525b', marginBottom: 8 }}>
          {label.toUpperCase()} · OFFLINE
        </div>
        <p style={{ fontSize: 13, color: '#71717a', lineHeight: 1.6 }}>
          Not built yet — placeholder rail destination. Use Caye Command for monitoring, source scheduling, and conversations for now.
        </p>
      </div>
    </div>
  )
}

// The founder's entire dashboard, one page — matches the reference
// mockup's structure (placements sidebar, top status bar, overview
// cards, calendar + conversations side by side). All data here is real
// (2026-07-02 data-wiring pass): placements list from workspace-context,
// bookings/conversations/escalations/spend/deployment status from
// /api/founder/command-overview. Replaces the old FounderHome + CayePanel
// slide-out entirely — no more panel-toggle model for founders.
export default function FounderHome() {
  const router = useRouter()
  const { workspace, workspaceId, workspaces } = useWorkspace()
  const { data } = useCommandOverview(workspaceId)
  const [expanded, setExpanded] = useState<'calendar' | 'conversations' | null>(null)
  const [railView, setRailView] = useState<RailId>('dashboard')
  const activeRailItem = RAIL_ITEMS.find((r) => r.id === railView)!

  return (
    <div style={{ display: 'flex', height: '100%', background: APP_BG, color: '#f4f4f5', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      {/* ── Icon rail — Caye Command / Placements are real, the rest are
          stub destinations matching how the reference mockup itself
          left them (unbuilt), per explicit direction to add the rail
          now with temp pages rather than wait for all of it. ── */}
      <nav style={{
        width: 64, flexShrink: 0, background: '#08080a', borderRight: `1px solid ${CARD_BORDER}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px 0',
      }}>
        <div style={{ marginBottom: 6 }}><CayeMark size={28} /></div>
        {RAIL_ITEMS.map((item) => (
          <RailButton key={item.id} item={item} active={railView === item.id} onClick={() => setRailView(item.id)} />
        ))}
      </nav>

      {/* ── Placements sidebar (real cross-workspace list) ── */}
      <aside style={{ width: 250, flexShrink: 0, borderRight: `1px solid ${CARD_BORDER}`, padding: 16, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <CayeMark size={20} />
          <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', color: LABEL_COLOR }}>
            PLACEMENTS
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {workspaces.map((m) => {
            const active = m.workspace_id === workspaceId
            return (
              <button
                key={m.workspace_id}
                onClick={() => router.push(`/dashboard/${m.workspace_id}`)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  textAlign: 'left', border: `1px solid ${active ? '#2d2d34' : 'transparent'}`,
                  cursor: 'pointer', borderRadius: 12,
                  padding: '12px 14px',
                  background: active ? 'rgba(24,24,27,0.9)' : 'transparent',
                }}
              >
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Top status bar */}
        <div style={{ padding: '16px 24px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-display)', margin: 0 }}>{workspace.business_name}</h1>
          <StatusPill status={workspace.status} />
        </div>

        {activeRailItem.stub ? (
          <StubConsole label={activeRailItem.label} />
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
            {/* Overview strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <StatCard
                label="Deployment"
                value={data ? (data.whatsapp_outbound_enabled ? 'Active & Chatting' : 'Paused') : '—'}
                valueColor={data?.whatsapp_outbound_enabled ? '#34d399' : '#71717a'}
              />
              <StatCard label="Bookings this week" value={data ? String(data.bookings.length) : '—'} />
              <StatCard
                label="Needs review"
                value={data ? String(data.pending_escalation_count) : '—'}
                valueColor={data && data.pending_escalation_count > 0 ? '#fb7185' : '#f4f4f5'}
              />
              <StatCard label="7-day spend" value={data ? `$${data.total_cost_usd.toFixed(2)}` : '—'} />
            </div>

            {/* Calendar + Conversations. Either can expand to take the full
                row — the other stays mounted but hidden, so its state
                (open thread, list scroll position) survives collapsing
                back rather than resetting. */}
            <div style={{
              flex: 1, display: 'grid',
              gridTemplateColumns: expanded ? '1fr' : '1fr 1fr',
              gap: 14, minHeight: 420,
            }}>
              <div style={{
                display: expanded === 'conversations' ? 'none' : 'block',
                position: 'relative',
                border: `1px solid ${CARD_BORDER}`, borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                <ExpandButton expanded={expanded === 'calendar'} onClick={() => setExpanded(expanded === 'calendar' ? null : 'calendar')} />
                {data && <CommandCalendar bookings={data.bookings} weekStart={data.week_start} />}
              </div>
              <div style={{
                display: expanded === 'calendar' ? 'none' : 'block',
                position: 'relative',
                border: `1px solid ${CARD_BORDER}`, borderRadius: 16, overflow: 'hidden', background: CARD_BG,
              }}>
                <ExpandButton expanded={expanded === 'conversations'} onClick={() => setExpanded(expanded === 'conversations' ? null : 'conversations')} />
                {data && <CommandConversations workspaceId={workspaceId} conversations={data.conversations} />}
              </div>
            </div>

            {/* Caye Direct — same back-office agent the founder already
                texts over WhatsApp, now with a web front end. Employee
                Performance Scorecard will take the other half of this
                row once built (next pass). */}
            <div style={{ height: 380, border: `1px solid ${CARD_BORDER}`, borderRadius: 16, overflow: 'hidden', background: CARD_BG }}>
              <CayeDirect workspaceId={workspaceId} />
            </div>

            <div aria-hidden style={{ height: 3, borderRadius: 3, background: GRADIENT, opacity: 0.4 }} />
          </div>
        )}
      </div>
    </div>
  )
}
