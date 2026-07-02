'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeMark } from '@/components/brand/CayeMark'
import CayeDirectThread from './CayeDirectThread'

const CARD_BORDER = '#1f1f23'
const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

interface Operator {
  id: number
  name: string | null
  role: 'owner' | 'staff' | 'founder'
}

const ROLE_LABEL: Record<Operator['role'], string> = {
  founder: 'Founder',
  owner: 'Owner',
  staff: 'Staff',
}

function operatorLabel(op: Operator): string {
  if (op.name) return op.name
  return op.role === 'founder' ? 'You' : ROLE_LABEL[op.role]
}

function OperatorRow({ op, active, onClick }: { op: Operator; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const label = operatorLabel(op)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        border: 'none', cursor: 'pointer', borderRadius: 10, padding: '9px 10px 9px 13px', marginBottom: 2,
        background: active ? 'rgba(125,201,203,0.09)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{ position: 'absolute', left: 3, top: 7, bottom: 7, width: 2.5, borderRadius: 3, background: '#7DC9CB' }} />
      )}
      <div style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(125,201,203,0.12)', color: '#7DC9CB', fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
      }}>
        {label.slice(0, 1).toUpperCase()}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#f4f4f5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </div>
        <div style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {ROLE_LABEL[op.role]}
        </div>
      </div>
    </button>
  )
}

// Read-only operator switcher (owner/staff/founder from operator_allowlist)
// + a per-operator conversation thread. No add/edit/remove here — team
// membership changes stay a Caye-chat action (the add_team_member tool),
// per the dashboard's locked scope in Products/Caye/CLAUDE.md. This is
// purely a lens on operators who already exist, same as Command
// Conversations is a lens on unified_conversations.
export default function CayeDirect({ workspaceId }: { workspaceId: string }) {
  const [operators, setOperators] = useState<Operator[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setOperators(null)
    setSelectedId(null)
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/caye-operators?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled || !res.ok) return
      const ops: Operator[] = json.operators ?? []
      setOperators(ops)
      const founder = ops.find((o) => o.role === 'founder')
      setSelectedId(founder?.id ?? ops[0]?.id ?? null)
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  const selected = operators?.find((o) => o.id === selectedId) ?? null

  return (
    <div style={{ display: 'flex', height: '100%', color: '#f4f4f5' }}>
      <div style={{ width: 168, flexShrink: 0, borderRight: `1px solid ${CARD_BORDER}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', padding: '14px 14px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CayeMark size={18} />
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.05em' }}>CAYE DIRECT</span>
          </div>
          <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, background: GRADIENT, opacity: 0.35 }} />
        </div>
        <div style={{ padding: '8px 6px', flex: 1, overflowY: 'auto' }}>
          {operators === null ? (
            <div style={{ fontSize: 11, color: '#52525b', padding: '6px 8px' }}>Loading…</div>
          ) : operators.length === 0 ? (
            <div style={{ fontSize: 11, color: '#52525b', padding: '6px 8px' }}>No operators yet.</div>
          ) : (
            operators.map((op) => (
              <OperatorRow key={op.id} op={op} active={op.id === selectedId} onClick={() => setSelectedId(op.id)} />
            ))
          )}
        </div>
      </div>

      {selected ? (
        <CayeDirectThread
          key={selected.id}
          workspaceId={workspaceId}
          operatorId={selected.id}
          operatorLabel={operatorLabel(selected)}
          readOnly={selected.role !== 'founder'}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: 13 }}>
          {operators === null ? 'Loading…' : 'Select an operator.'}
        </div>
      )}
    </div>
  )
}
