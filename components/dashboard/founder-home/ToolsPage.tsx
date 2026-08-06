'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'

const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'

type ToolRisk = 'read' | 'low' | 'high'

interface ToolInfo {
  name: string
  description: string
  risk: ToolRisk
  roles: string[]
  modes: string[]
}

const RISK_COLOR: Record<ToolRisk, string> = {
  read: '#71717a',
  low: '#4EBECE',
  high: '#fb7185',
}
const RISK_LABEL: Record<ToolRisk, string> = {
  read: 'Read',
  low: 'Low-risk write',
  high: 'High-risk write',
}
// Read/low execute autonomously; high triggers a confirmation round-trip
// (gateHighRisk / gateAdminHighRisk) — same tiers as registry.ts's own
// grouping, kept in this fixed order regardless of what's present.
const RISK_ORDER: ToolRisk[] = ['read', 'low', 'high']

function ModeTag({ mode }: { mode: string }) {
  return (
    <span style={{
      fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em',
      color: LABEL_COLOR, background: 'rgba(255,255,255,0.05)', borderRadius: 5, padding: '2px 6px',
    }}>
      {mode}
    </span>
  )
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  const color = RISK_COLOR[tool.risk]
  return (
    <div style={{ padding: '10px 0', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: '#f4f4f5', fontWeight: 600 }}>{tool.name}</span>
        <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {tool.modes.map((m) => <ModeTag key={m} mode={m} />)}
        </span>
      </div>
      <p style={{ fontSize: 12, color: LABEL_COLOR, lineHeight: 1.5, margin: '4px 0 0 13px' }}>
        {tool.description}
      </p>
      <div style={{ margin: '5px 0 0 13px', fontSize: 10.5, color: '#52525b', fontFamily: 'var(--font-mono)' }}>
        {tool.roles.join(' · ')}
      </div>
    </div>
  )
}

function RiskGroup({ risk, tools }: { risk: ToolRisk; tools: ToolInfo[] }) {
  const [expanded, setExpanded] = useState(risk !== 'high')
  const color = RISK_COLOR[risk]
  return (
    <div style={{ background: CARD_BG, borderRadius: 16, overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 10, background: `${color}17`, color, flexShrink: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {risk === 'read' ? (
              <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>
            ) : risk === 'low' ? (
              <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>
            ) : (
              <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
            )}
          </svg>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5' }}>{RISK_LABEL[risk]}</div>
          <div style={{ fontSize: 11.5, color: LABEL_COLOR, marginTop: 2 }}>
            {tools.length} tool{tools.length === 1 ? '' : 's'}{risk === 'high' ? ' — confirmation required' : ' — autonomous'}
          </div>
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {expanded && (
        <div style={{ padding: '0 16px 6px', borderTop: '1px solid rgba(255,255,255,0.04)', maxHeight: 360, overflowY: 'auto' }}>
          {tools.map((t) => <ToolRow key={t.name} tool={t} />)}
        </div>
      )}
    </div>
  )
}

// Snapshot-on-load, no polling — capability inventory changes when code
// ships, not minute to minute. Grouped by risk tier (registry.ts's own
// grouping) so the confirmation-gated tools are easy to find as a set.
export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/tools', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled) return
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setTools(json.tools)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const grouped = useMemo(() => {
    if (!tools) return null
    return RISK_ORDER.map((risk) => ({ risk, tools: tools.filter((t) => t.risk === risk) })).filter((g) => g.tools.length > 0)
  }, [tools])

  if (error) {
    return <div style={{ flex: 1, padding: 20, fontSize: 12.5, color: '#fb7185' }}>{error}</div>
  }
  if (grouped === null) {
    return <div style={{ flex: 1, padding: 20 }}><CayeLoadingPulse size={16} /></div>
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: LABEL_COLOR }}>{tools?.length ?? 0} tools in TOOL_REGISTRY</span>
        <Pill color="#71717a" label="No usage metrics yet" dot={false} />
      </div>
      {grouped.map((g) => <RiskGroup key={g.risk} risk={g.risk} tools={g.tools} />)}
    </div>
  )
}
