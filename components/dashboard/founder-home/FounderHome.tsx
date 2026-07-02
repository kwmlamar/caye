'use client'

import { useRouter } from 'next/navigation'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'
import type { CustomerStatus } from '@/types/database'

const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: 'Live',
  trial: 'Trial',
  inactive: 'Dormant',
  suspended: 'Blocked',
}
const STATUS_COLOR: Record<CustomerStatus, string> = {
  active: '#22c55e',
  trial: '#FFD68F',
  inactive: 'rgba(245,245,244,0.4)',
  suspended: '#ff8a6b',
}

function StatusPill({ status }: { status: CustomerStatus }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      color: STATUS_COLOR[status], border: `1px solid ${STATUS_COLOR[status]}55`,
      borderRadius: 999, padding: '2px 8px', flexShrink: 0,
    }}>
      {STATUS_LABEL[status]}
    </span>
  )
}

// The founder's entire dashboard, one page — matches the reference
// mockup's structure (placements sidebar, top status bar, overview
// cards, calendar + conversations side by side), built with a strong
// preference for real data over new mocks: the placements list, workspace
// name, and status all come from the founder's actual cross-workspace
// membership already wired in workspace-context, not invented data.
// Only "Bookings made" and "Deployment" below are still placeholders —
// Calendar/Conversations bodies are mock (2026-07-02 frontend-first
// pass); Needs Review + Weekly Spend are real (useCommandOverview).
// Replaces the old FounderHome + CayePanel slide-out entirely: no more
// panel-toggle model for founders.
export default function FounderHome() {
  const router = useRouter()
  const { workspace, workspaceId, workspaces } = useWorkspace()
  const { data } = useCommandOverview(workspaceId)

  return (
    <div style={{ display: 'flex', height: '100%', background: '#0a0a0b', color: '#f5f5f4', overflow: 'hidden' }}>
      {/* ── Placements sidebar (real cross-workspace list) ── */}
      <aside style={{ width: 240, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.08)', padding: 16, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <CayeMark size={20} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'rgba(245,245,244,0.55)' }}>
            PLACEMENTS
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {workspaces.map((m) => (
            <button
              key={m.workspace_id}
              onClick={() => router.push(`/dashboard/${m.workspace_id}`)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 10,
                padding: '10px 10px',
                background: m.workspace_id === workspaceId ? 'rgba(255,255,255,0.06)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.customer.business_name}
              </span>
              <StatusPill status={m.customer.status} />
            </button>
          ))}
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top status bar */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{workspace.business_name}</h1>
          <StatusPill status={workspace.status} />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
          {/* Overview strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>Deployment</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e', marginTop: 6 }}>Active & Chatting</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>Bookings made</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>—</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>Needs review</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: data && data.pending_escalation_count > 0 ? '#ff8a6b' : '#f5f5f4', marginTop: 4 }}>
                {data ? data.pending_escalation_count : '—'}
              </div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>7-day spend</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {data ? `$${data.total_cost_usd.toFixed(2)}` : '—'}
              </div>
            </div>
          </div>

          {/* Calendar + Conversations, side by side, always visible */}
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, minHeight: 420 }}>
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
              <CommandCalendar />
            </div>
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
              <CommandConversations />
            </div>
          </div>

          <div aria-hidden style={{ height: 3, borderRadius: 3, background: GRADIENT, opacity: 0.4 }} />
        </div>
      </div>
    </div>
  )
}
