'use client'

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ThreadRowMenuProps {
  anchorEl: HTMLElement
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

export default function ThreadRowMenu({ anchorEl, onRename, onDelete, onClose }: ThreadRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    const r = anchorEl.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left })
  }, [anchorEl])

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        minWidth: 140,
        background: '#ffffff',
        border: '1px solid rgba(14, 26, 26, 0.08)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(14, 26, 26, 0.08), 0 2px 8px rgba(14, 26, 26, 0.04)',
        overflow: 'hidden',
        padding: 4,
      }}
    >
      <button
        onClick={() => { onRename(); onClose() }}
        style={menuItemStyle}
        onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.04)'}
        onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
      >
        Rename
      </button>
      <button
        onClick={() => { onDelete(); onClose() }}
        style={{ ...menuItemStyle, color: '#B91C1C' }}
        onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'rgba(185, 28, 28, 0.06)'}
        onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
      >
        Delete
      </button>
    </div>,
    document.body,
  )
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '7px 10px',
  borderRadius: 7,
  background: 'transparent',
  fontSize: 13,
  color: '#0E1A1A',
  cursor: 'pointer',
  border: 'none',
  transition: 'background 0.12s ease',
}
