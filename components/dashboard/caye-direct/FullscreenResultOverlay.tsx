'use client'

import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'

export function FullscreenResultOverlay({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(3,5,7,.86)',
        backdropFilter: 'blur(12px)',
        padding: 18,
        display: 'grid',
        placeItems: 'center',
        color: '#f4f4f5',
      }}
    >
      <div style={{
        width: 'min(1440px, calc(100vw - 36px))',
        height: 'calc(100vh - 36px)',
        background: '#0d0f11',
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: 18,
        boxShadow: '0 24px 80px rgba(0,0,0,.55)',
        overflow: 'hidden',
        display: 'grid',
        gridTemplateRows: '48px minmax(0,1fr)',
        color: '#f4f4f5',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '0 14px 0 18px',
          borderBottom: '1px solid rgba(255,255,255,.08)',
        }}>
          <div style={{ minWidth: 0, fontSize: 12, fontWeight: 650, color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close full screen"
            title="Close (Esc)"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,.12)',
              background: 'rgba(255,255,255,.055)',
              color: '#e4e4e7',
              cursor: 'pointer',
              fontSize: 17,
              lineHeight: 1,
            }}
          >×</button>
        </div>
        <div style={{ minHeight: 0, overflow: 'auto', padding: 18, color: '#f4f4f5' }}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function ExpandResultButton({ onClick, label = 'Open full screen' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.035)',
        color: '#c7c9d0',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 3H3v5" />
        <path d="M16 3h5v5" />
        <path d="M8 21H3v-5" />
        <path d="M16 21h5v-5" />
      </svg>
    </button>
  )
}
