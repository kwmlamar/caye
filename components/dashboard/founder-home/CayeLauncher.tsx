'use client'

import { useState } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { TEXT_QUIET } from '../surface'

/**
 * Inbox gives its own customer reply composer priority. This quiet floating
 * control is therefore only a summoner: it opens the same global Caye Direct
 * overlay used by the full Ask Caye bar everywhere else, never a second chat
 * input with competing state.
 */
export default function CayeLauncher({ onOpenHistory }: {
  /** Retained as optional for older call sites; opening the overlay is the
   * only valid interaction for this launcher. */
  onSend?: (text: string) => void
  onOpenHistory?: () => void
  busy?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onOpenHistory}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-haspopup="dialog"
      aria-label="Ask Caye anything"
      title="Ask Caye"
      style={{
        position: 'absolute', right: 20, bottom: 'calc(var(--caye-reply-composer-height, 0px) + 24px)', zIndex: 15,
        display: 'flex', alignItems: 'center', gap: 8, border: 'none', cursor: 'pointer', borderRadius: 999, padding: '9px 16px 9px 10px',
        background: hover ? 'rgba(78,190,206,0.08)' : 'rgba(255,255,255,0.035)',
        backdropFilter: 'blur(18px) saturate(150%)', WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        boxShadow: hover ? '0 1px 0 rgba(255,255,255,0.05) inset, 0 0 16px rgba(78,190,206,0.14), 0 8px 20px rgba(0,0,0,0.28)' : '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.28)',
        color: TEXT_QUIET, fontSize: 12.5, fontWeight: 600, transition: 'background 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <CayeMark size={18} />
      Ask Caye
    </button>
  )
}
