'use client'

import { useState, type ReactNode } from 'react'
import { getSession } from '@/lib/supabase'
import type { CommandOverview } from '@/lib/useCommandOverview'
import { GhostButton } from './console-ui'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

// Moved out of FounderHome verbatim — founder-only pause/resume, writes the
// same workspace_ai_config fields the WhatsApp mute_caye/unmute_caye tools
// write (see app/api/founder/caye-toggle/route.ts).
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
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

function Metric({ label, value, valueColor = '#f4f4f5', action, first }: {
  label: string; value: string; valueColor?: string; action?: ReactNode; first?: boolean
}) {
  return (
    <div style={{
      flex: 1, minWidth: 110, padding: '4px 20px',
      borderLeft: first ? 'none' : `1px solid ${CARD_BORDER}`,
    }}>
      <div style={{
        fontSize: 10.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 19, fontFamily: 'var(--font-display)', fontWeight: 600,
          color: valueColor, fontVariantNumeric: 'tabular-nums',
        }}>
          {value}
        </span>
        {action}
      </div>
    </div>
  )
}

export default function BusinessPulse({
  data, workspaceId, weekLabel, onDeploymentToggled,
}: {
  data: CommandOverview | null
  workspaceId: string
  weekLabel: string
  onDeploymentToggled: () => void
}) {
  return (
    <div style={{
      flexShrink: 0, background: '#1a1a1e', borderRadius: 16, border: `1px solid ${CARD_BORDER}`,
      display: 'flex', flexWrap: 'wrap', padding: '16px 0',
    }}>
      <Metric
        first
        label="Deployment"
        value={data ? (data.caye_active ? 'Active' : 'Paused') : '—'}
        valueColor={data?.caye_active ? '#34d399' : '#71717a'}
        action={data && <DeploymentToggle workspaceId={workspaceId} active={data.caye_active} onToggled={onDeploymentToggled} />}
      />
      <Metric label={weekLabel} value={data ? String(data.bookings.length) : '—'} />
      <Metric
        label="Needs review"
        value={data ? String(data.pending_escalation_count) : '—'}
        valueColor={data && data.pending_escalation_count > 0 ? '#fb7185' : '#f4f4f5'}
      />
      <Metric label="7-day spend" value={data ? `$${data.total_cost_usd.toFixed(2)}` : '—'} />
    </div>
  )
}
