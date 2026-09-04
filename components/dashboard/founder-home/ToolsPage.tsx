'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { groupToolsByCategory } from '@/lib/tool-categories'

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
  low: 'Low-risk',
  high: 'Confirmation required',
}
const RISK_ORDER: ToolRisk[] = ['read', 'low', 'high']

function RiskBadge({ risk }: { risk: ToolRisk }) {
  return (
    <span style={{
      fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em',
      color: RISK_COLOR[risk], flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {RISK_LABEL[risk]}
    </span>
  )
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  return (
    <div style={{ padding: '9px 0', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: '#f4f4f5', fontWeight: 600 }}>{tool.name}</span>
        <span style={{ marginLeft: 'auto' }}><RiskBadge risk={tool.risk} /></span>
      </div>
      <p style={{ fontSize: 12, color: LABEL_COLOR, lineHeight: 1.5, margin: '4px 0 0' }}>
        {tool.description}
      </p>
    </div>
  )
}

function CapabilityGroup({ label, tools }: { label: string; tools: ToolInfo[] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 2px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f4f4f5' }}>{label}</div>
          <div style={{ fontSize: 11.5, color: LABEL_COLOR, marginTop: 2 }}>
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </div>
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {expanded && (
        <div style={{ padding: '0 2px 10px' }}>
          {tools.map((t) => <ToolRow key={t.name} tool={t} />)}
        </div>
      )}
    </div>
  )
}

function RiskTierGroup({ risk, tools }: { risk: ToolRisk; tools: ToolInfo[] }) {
  const [expanded, setExpanded] = useState(risk === 'high')
  return (
    <div style={{ boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 2px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f4f4f5' }}>{RISK_LABEL[risk]}</div>
          <div style={{ fontSize: 11.5, color: LABEL_COLOR, marginTop: 2 }}>
            {tools.length} tool{tools.length === 1 ? '' : 's'}{risk === 'high' ? ' — confirmation required before executing' : ' — runs autonomously'}
          </div>
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {expanded && (
        <div style={{ padding: '0 2px 10px' }}>
          {tools.map((t) => (
            <div key={t.name} style={{ padding: '9px 0', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: '#f4f4f5', fontWeight: 600 }}>{t.name}</span>
                <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                  {t.modes.map((m) => (
                    <span key={m} style={{
                      fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em',
                      color: LABEL_COLOR, background: 'rgba(255,255,255,0.05)', borderRadius: 5, padding: '2px 6px',
                    }}>{m}</span>
                  ))}
                </span>
              </div>
              <p style={{ fontSize: 12, color: LABEL_COLOR, lineHeight: 1.5, margin: '4px 0 0' }}>{t.description}</p>
              <div style={{ marginTop: 4, fontSize: 10.5, color: '#52525b', fontFamily: 'var(--font-mono)' }}>{t.roles.join(' · ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: 'capabilities' | 'registry'; onChange: (v: 'capabilities' | 'registry') => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 9, background: 'rgba(255,255,255,0.04)' }}>
      {(['capabilities', 'registry'] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            border: 'none', cursor: 'pointer', borderRadius: 7, padding: '5px 10px',
            fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
            background: view === v ? 'rgba(255,255,255,0.09)' : 'transparent',
            color: view === v ? '#f4f4f5' : LABEL_COLOR,
          }}
        >
          {v === 'capabilities' ? 'What she can do' : 'Developer view'}
        </button>
      ))}
    </div>
  )
}

// Snapshot-on-load, no polling — capability inventory changes when code
// ships, not minute to minute.
//
// Two views over the same /api/founder/tools data (2026-08-26 redesign):
// "What she can do" groups by product capability (lib/tool-categories.ts)
// with risk shown as a per-tool badge — this is the primary, founder-
// legible view, replacing a raw registry dump as the default. "Developer
// view" preserves the original risk-tier grouping (read/low-risk/
// confirmation-required) for debugging which tools are gated — nothing
// about the underlying data changes, only which grouping renders first.
export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'capabilities' | 'registry'>('capabilities')

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

  const capabilityGroups = useMemo(() => tools ? groupToolsByCategory(tools) : null, [tools])
  const riskGroups = useMemo(() => {
    if (!tools) return null
    return RISK_ORDER.map((risk) => ({ risk, tools: tools.filter((t) => t.risk === risk) })).filter((g) => g.tools.length > 0)
  }, [tools])

  if (error) {
    return <div style={{ flex: 1, padding: 20, fontSize: 12.5, color: '#fb7185' }}>{error}</div>
  }
  if (tools === null || capabilityGroups === null || riskGroups === null) {
    return <div style={{ flex: 1, padding: 20 }}><CayeLoadingPulse size={16} /></div>
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 12.5, color: LABEL_COLOR, margin: 0, lineHeight: 1.5 }}>
          {tools.length} tools Caye can use — grouped by what they do, or by how she's allowed to use them.
        </p>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {view === 'capabilities'
        ? capabilityGroups.map((g) => <CapabilityGroup key={g.category.id} label={g.category.label} tools={g.tools} />)
        : riskGroups.map((g) => <RiskTierGroup key={g.risk} risk={g.risk} tools={g.tools} />)}
    </div>
  )
}
