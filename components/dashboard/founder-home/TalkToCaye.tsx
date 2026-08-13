'use client'

import { useState, type KeyboardEvent } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { AQUA, TEXT, TEXT_QUIET } from '../surface'

/**
 * "Ask Caye anything…" — closer to messaging an employee than a generic
 * chatbot input because it IS that: submitting hands the text to the real
 * Caye Direct thread (same back-office agent operators text over
 * WhatsApp), not a separate composer with its own fake reply logic. See
 * FounderHome's `talkToCayeDraft` state, which expands the Caye Direct
 * panel and passes this straight through to CayeDirectThread's
 * initialMessage.
 *
 * 2026-08-13: rebuilt to float rather than sit in a footer bar — no
 * opaque container, no border by default. Idle it's nearly silent; focus
 * brings up a soft aqua glow rather than a hard outline, closer to Caye's
 * own light turning toward the composer than a form validation ring.
 *
 * No mic/voice affordance — WhatsApp voice calling is "idea, not started"
 * (voice-calling-roadmap.md), so nothing here pretends otherwise.
 */
export default function TalkToCaye({ onSend, onOpenHistory, busy }: {
  onSend: (text: string) => void
  onOpenHistory?: () => void
  busy?: boolean
}) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [hover, setHover] = useState(false)
  const active = focused || hover

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
    <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '4px 0 2px' }}>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth: 600,
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={value.trim() ? '#111113' : TEXT_QUIET} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
