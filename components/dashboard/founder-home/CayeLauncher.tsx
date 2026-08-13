'use client'

import { useState, useRef, useEffect, useId } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { TEXT_QUIET } from '../surface'
import AskCayeComposer from './AskCayeComposer'

/**
 * Inbox-only stand-in for the global TalkToCaye bar. On every other page
 * "reply to the customer" isn't competing for attention, so the full
 * floating composer is correct there. On Inbox, the customer reply
 * composer is the primary action — a second full-width "Ask Caye
 * anything" bar at equal visual weight was directly overlapping/
 * competing with it. This collapses Caye down to a small, quiet launcher
 * until the founder actually wants her, then expands into the exact same
 * AskCayeComposer pill TalkToCaye uses everywhere else.
 *
 * Positioned bottom-right, above the reply composer's own vertical span,
 * rather than beside it — the list/thread column split is user-resizable,
 * so anchoring by a fixed left/right offset next to a variable-width
 * column risked drifting into the reply composer on some split ratios.
 * Stacking vertically instead sidesteps that entirely, matching the
 * reference layout's own floating-panel-above-the-composer arrangement.
 *
 * The vertical offset itself tracks --caye-reply-composer-height, a CSS
 * custom property CommandConversations publishes from a ResizeObserver on
 * its actual composer element (see that file's composerWrapperRef comment)
 * — not a fixed guess. A fixed offset was tuned for a one-line composer and
 * started rendering CayeLauncher inside the composer once a draft grew past
 * one line (2026-08-13); this reads the real, current height instead, so it
 * tracks the composer through every state (collapsed, multiline, long
 * drafts, window resizes) rather than one tuned snapshot of it. Falls back
 * to 0px — sitting close to the bottom edge — when nothing publishes the
 * property: no active conversation, or a channel with no composer at all
 * (see CommandConversations' SEND_UNSUPPORTED).
 *
 * No conversation context is passed to Caye here — see the doc comment
 * on FounderHome's CayeLauncher usage for why (the backend route has no
 * field for it today). This stays a generic "ask Caye anything" input,
 * not a fabricated "Caye already knows what you're looking at."
 */
export default function CayeLauncher({ onSend, onOpenHistory, busy }: {
  onSend: (text: string) => void
  onOpenHistory?: () => void
  busy?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [hover, setHover] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const rawId = useId().replace(/[:]/g, '')

  useEffect(() => {
    if (!expanded) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') setExpanded(false) }
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onDocClick)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [expanded])

  function handleSend(text: string) {
    onSend(text)
    // Collapses back to the quiet launcher once she's been handed the
    // message — matches "after sending, it may collapse back."
    setExpanded(false)
  }

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute', right: 20,
        bottom: 'calc(var(--caye-reply-composer-height, 0px) + 24px)', zIndex: 15,
        pointerEvents: 'none', display: 'flex', justifyContent: 'flex-end',
        transition: 'bottom 0.15s ease',
      }}
    >
      <style>{`
        @keyframes ${rawId}-pulse { 0%, 100% { opacity: 0.55; transform: scale(0.92); } 50% { opacity: 1; transform: scale(1); } }
        @keyframes ${rawId}-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
        .${rawId}-icon { animation: ${rawId}-pulse 2.6s ease-in-out infinite; }
        .${rawId}-panel { animation: ${rawId}-in 0.16s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .${rawId}-icon { animation: none !important; }
          .${rawId}-panel { animation: none !important; }
        }
      `}</style>

      {expanded ? (
        <div className={reduced ? '' : `${rawId}-panel`} style={{ pointerEvents: 'auto', width: 340 }}>
          <AskCayeComposer onSend={handleSend} onOpenHistory={onOpenHistory} busy={busy} autoFocus maxWidth={340} />
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-haspopup="dialog"
          aria-expanded={false}
          aria-label="Ask Caye anything"
          title="Ask Caye"
          style={{
            pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8,
            border: 'none', cursor: 'pointer', borderRadius: 999, padding: '9px 16px 9px 10px',
            background: hover ? 'rgba(78,190,206,0.08)' : 'rgba(255,255,255,0.035)',
            backdropFilter: 'blur(18px) saturate(150%)',
            WebkitBackdropFilter: 'blur(18px) saturate(150%)',
            boxShadow: hover
              ? '0 1px 0 rgba(255,255,255,0.05) inset, 0 0 16px rgba(78,190,206,0.14), 0 8px 20px rgba(0,0,0,0.28)'
              : '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.28)',
            color: TEXT_QUIET, fontSize: 12.5, fontWeight: 600,
            transition: 'background 0.15s ease, box-shadow 0.15s ease',
          }}
        >
          <span className={reduced ? '' : `${rawId}-icon`} style={{ display: 'flex' }}>
            <CayeMark size={18} />
          </span>
          Ask Caye
        </button>
      )}
    </div>
  )
}
