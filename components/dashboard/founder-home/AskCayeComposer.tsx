'use client'

import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { AQUA, TEXT, TEXT_QUIET } from '../surface'

/**
 * The actual "Caye icon | input | send" pill — shared by TalkToCaye (the
 * always-expanded bar on Home/Work/People/Memory/Settings) and
 * CayeLauncher's expanded state (Inbox, where the full bar would compete
 * with the customer reply composer). One implementation, two contexts,
 * so the visual language stays identical regardless of which is showing.
 */
export default function AskCayeComposer({
  onSend, onOpenHistory, busy, autoFocus, maxWidth = 600,
}: {
  onSend: (text: string) => void
  onOpenHistory?: () => void
  busy?: boolean
  autoFocus?: boolean
  maxWidth?: number
}) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [hover, setHover] = useState(false)
  const active = focused || hover
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth,
        background: `rgba(255,255,255,${focused ? 0.055 : hover ? 0.045 : 0.032})`,
        backdropFilter: 'blur(22px) saturate(150%)',
        WebkitBackdropFilter: 'blur(22px) saturate(150%)',
        borderRadius: 999, padding: '10px 10px 10px 16px',
        boxShadow: focused
          ? `0 1px 0 rgba(255,255,255,0.06) inset, 0 0 0 1px rgba(78,190,206,0.3), 0 0 28px rgba(78,190,206,0.18), 0 14px 32px rgba(0,0,0,0.35)`
          : `0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 26px rgba(0,0,0,0.3)`,
        transition: 'background 0.2s ease, box-shadow 0.25s ease',
      }}
    >
      {onOpenHistory ? (
        <button
          onClick={onOpenHistory}
          title="Open Caye Direct — full history"
          aria-label="Open Caye Direct — full history"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', padding: 0, flexShrink: 0 }}
        >
          <CayeMark size={20} />
        </button>
      ) : (
        <CayeMark size={20} />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Ask Caye anything…"
        aria-label="Ask Caye anything"
        disabled={busy}
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
          fontSize: 13.5, color: TEXT, fontFamily: 'var(--font-sans)',
        }}
      />
      <button
        onClick={submit}
        disabled={!value.trim() || busy}
        title="Send"
        aria-label="Send"
        style={{
          flexShrink: 0, width: 30, height: 30, borderRadius: '50%', border: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: value.trim() && !busy ? 'pointer' : 'default',
          background: value.trim() ? `linear-gradient(90deg, ${AQUA}, #FFE4AF)` : 'rgba(255,255,255,0.06)',
          opacity: value.trim() && !busy ? 1 : active ? 0.7 : 0.45,
          transition: 'opacity 0.15s ease',
        }}
      >
        {busy ? null : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={value.trim() ? '#111113' : TEXT_QUIET} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
          </svg>
        )}
      </button>
    </div>
  )
}
