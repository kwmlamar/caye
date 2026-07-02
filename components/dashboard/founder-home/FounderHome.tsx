'use client'

import { useState, useEffect } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useWorkspace } from '@/lib/workspace-context'
import { useDashboard } from '@/lib/dashboard-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import { getSession } from '@/lib/supabase'
import type { Screen } from '@/lib/types'

const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

function getFirstName(fullName?: string | null): string | undefined {
  if (!fullName) return undefined
  return fullName.trim().split(/\s+/)[0] || undefined
}

function getGreeting(firstName?: string) {
  const h = new Date().getHours()
  const base = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'
  return firstName ? `${base}, ${firstName}.` : `${base}.`
}

const LAUNCH_TABS: { id: Screen; label: string }[] = [
  { id: 'chats', label: 'Inbox' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'command', label: 'Command' },
]

// Founder's own landing view — distinct from HomeScreen, which is
// shared with the workspace owner (e.g. Karenda) and stays untouched.
// Minimal by design: a greeting, the same needs-review/spend numbers as
// the Command tab, and quick launchers into the founder panel. No chat
// interface here — that's HomeScreen's job for owners; founders reach
// Caye through the panel tabs or WhatsApp back-office.
export default function FounderHome() {
  const { workspace, workspaceId } = useWorkspace()
  const { setPanelOpen, setPanelScreen } = useDashboard()
  const { data, loading } = useCommandOverview(workspaceId)
  const [firstName, setFirstName] = useState<string | undefined>()

  useEffect(() => {
    getSession().then(({ session }) => {
      setFirstName(getFirstName(session?.user?.user_metadata?.full_name))
    })
  }, [])

  const openTab = (id: Screen) => {
    setPanelScreen(id)
    setPanelOpen(true)
  }

  return (
    <div style={{
      height: '100%',
      overflowY: 'auto',
      background: '#0a0a0b',
      color: '#f5f5f4',
      padding: '48px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: 32,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <CayeMark size={40} />
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
            {getGreeting(firstName)}
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(245,245,244,0.45)', marginTop: 2 }}>
            {workspace?.business_name ?? 'Workspace'}
          </p>
        </div>
      </div>

      {!loading && data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 480 }}>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>
              Needs review
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: data.pending_escalation_count > 0 ? '#ff8a6b' : '#f5f5f4', marginTop: 4 }}>
              {data.pending_escalation_count}
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>
              7-day spend
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#f5f5f4', marginTop: 4 }}>
              ${data.total_cost_usd.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(245,245,244,0.5)', marginBottom: 10 }}>
          Open
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {LAUNCH_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => openTab(tab.id)}
              style={{
                padding: '10px 18px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.04)',
                color: '#f5f5f4',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div aria-hidden style={{ height: 3, borderRadius: 3, background: GRADIENT, opacity: 0.5, marginTop: 'auto', maxWidth: 480 }} />
    </div>
  )
}
