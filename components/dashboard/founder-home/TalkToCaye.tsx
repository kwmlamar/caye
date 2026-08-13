'use client'

import { useState, type KeyboardEvent } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'

const CARD_BORDER = '#28282d'

/**
 * "Ask Caye anything…" — closer to messaging an employee than a generic
 * chatbot input because it IS that: submitting hands the text to the real
 * Caye Direct thread (same back-office agent operators text over
 * WhatsApp), not a separate composer with its own fake reply logic. See
 * FounderHome's `talkToCayeDraft` state, which expands the Caye Direct
 * panel and passes this straight through to CayeDirectThread's
 * initialMessage.
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
    <div style={{
      flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '4px 0 2px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth: 620,
        background: '#1a1a1e', border: `1px solid ${focused ? '#4EBECE55' : CARD_BORDER}`,
        borderRadius: 999, padding: '9px 10px 9px 16px',
        transition: 'border-color 0.15s ease',
      }}>
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
          disabled={busy}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            fontSize: 13.5, color: '#f4f4f5', fontFamily: 'var(--font-sans)',
          }}
        />
        <button
          onClick={submit}
          disabled={!value.trim() || busy}
          title="Send"
          style={{
            flexShrink: 0, width: 30, height: 30, borderRadius: '50%', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: value.trim() && !busy ? 'pointer' : 'default',
            background: value.trim() ? 'linear-gradient(90deg, #4EBECE, #FFE4AF)' : 'rgba(255,255,255,0.06)',
            opacity: value.trim() && !busy ? 1 : 0.5,
            transition: 'opacity 0.15s ease',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={value.trim() ? '#111113' : '#71717a'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
