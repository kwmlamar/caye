'use client'

import { useState, useRef, useEffect } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import { sidebarPopoverSurface, paneShadowSoft, AQUA, TEXT, TEXT_QUIET } from '../surface'
import type { WorkspaceMembership } from '@/lib/workspace-context'
import type { CustomerStatus } from '@/types/database'

const LABEL_COLOR = TEXT_QUIET

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: 'Live', trial: 'Trial', inactive: 'Dormant', suspended: 'Blocked',
}
const STATUS_COLOR: Record<CustomerStatus, string> = {
  active: '#34d399', trial: '#FFE4AF', inactive: '#71717a', suspended: '#fb7185',
}

/**
 * Replaces the permanent vertical column of workspace-initial buttons —
 * that cost real navigation space on every screen for a switch founders
 * make rarely. Now: logo + current workspace name + status, click opens a
 * popover with the rest. Same routing logic as before (onSelect), just
 * presentational here.
 */
export default function WorkspaceSwitcher({
  businessName, status, workspaces, activeWorkspaceId, onSelect, hasActivity, menuWidth = 280,
}: {
  businessName: string
  status: CustomerStatus
  workspaces: WorkspaceMembership[]
  activeWorkspaceId: string
  onSelect: (workspaceId: string) => void
  hasActivity: (workspaceId: string) => boolean
  /** The sidebar this now lives in is narrower (244px) than the popover's
   *  old default width — without this, the sidebar's own overflow:hidden
   *  (needed for the collapse-width animation) clips the popover's right
   *  edge. Callers in a wider context can leave this at 280. */
  menuWidth?: number
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Current workspace: ${businessName}, ${STATUS_LABEL[status]}. Click to switch.`}
        style={{
          width: '100%', minWidth: 0, overflow: 'hidden', boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px 6px 6px',
          borderRadius: 12, border: 'none', cursor: 'pointer',
          background: open ? 'rgba(255,255,255,0.06)' : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        <span style={{ display: 'flex', flexShrink: 0 }}>
          <CayeMark size={30} />
        </span>
        <div style={{ textAlign: 'left', flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <div style={{
            fontSize: 13.5, fontWeight: 600, color: '#f4f4f5', letterSpacing: '-0.01em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%',
          }}>
            {businessName}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: STATUS_COLOR[status] }} />
            <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: LABEL_COLOR, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {STATUS_LABEL[status]}
            </span>
          </div>
        </div>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={LABEL_COLOR} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 10px)', left: 0, zIndex: 100,
            width: menuWidth, borderRadius: 16, padding: 6,
            ...sidebarPopoverSurface(),
            boxShadow: paneShadowSoft,
            animation: 'caye-popover-in 0.16s ease-out',
          }}
        >
          <div style={{ padding: '8px 10px 6px', fontSize: 10.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR }}>
            Workspaces
          </div>
          {workspaces.map((m) => {
            const active = m.workspace_id === activeWorkspaceId
            return (
              <button
                key={m.workspace_id}
                role="option"
                aria-selected={active}
                onClick={() => { onSelect(m.workspace_id); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%',
                  textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 10,
                  padding: '9px 10px', background: active ? 'rgba(78,190,206,0.08)' : 'transparent',
                  transition: 'background 0.12s ease',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.035)' }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span aria-hidden style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: active ? AQUA : 'transparent',
                    boxShadow: active ? `0 0 6px ${AQUA}99` : 'none',
                  }} />
                  <span style={{
                    fontSize: 13, fontWeight: active ? 600 : 500, color: active ? TEXT : '#a1a1aa',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {m.customer.business_name ?? 'New signup'}
                  </span>
                  {hasActivity(m.workspace_id) && (
                    <span aria-hidden title="New activity" style={{ width: 5, height: 5, borderRadius: '50%', background: AQUA, flexShrink: 0, boxShadow: `0 0 0 2px ${AQUA}33` }} />
                  )}
                </span>
                <Pill color={STATUS_COLOR[m.customer.status]} label={STATUS_LABEL[m.customer.status]} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
