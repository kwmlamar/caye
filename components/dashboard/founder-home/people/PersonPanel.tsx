'use client'

import { useEffect, useState } from 'react'
import { formatDistanceToNow } from '@/lib/utils'
import { usePersonDetail } from '@/lib/usePeople'
import { CayeLoadingPulse } from '../CayeLoadingPulse'
import { TEXT, TEXT_QUIET, GOLD, AQUA, popoverSurface, paneShadow, rowDivider, attentionSurface } from '../../surface'
import { channelLabel } from '@/components/dashboard/command-conversations/channel-meta'

function XIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: TEXT_QUIET, marginBottom: 10 }}>
      {children}
    </div>
  )
}

/**
 * "Caye, what do you know about this person?" — a knowledge sheet, not a
 * contact-record editor. `fixed`, not `absolute`, matching the old
 * ContactDetail's own reasoning: the list column this opens over scrolls,
 * and a backdrop pinned to that column's box would scroll away from
 * rows revealed beneath it. Stronger glass than the page body (popoverSurface
 * + paneShadow, the LEVEL 3 "foreground overlay" treatment from surface.ts)
 * since this is drilling into Caye's knowledge, not page furniture.
 */
export default function PersonPanel({ workspaceId, personId, onClose, onReview }: {
  workspaceId: string
  personId: string
  onClose: () => void
  onReview: (conversationId: string) => void
}) {
  const { person, loading, error } = usePersonDetail(workspaceId, personId)
  const [closeHover, setCloseHover] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(9,9,11,0.6)', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 50 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '100%', ...popoverSurface(), boxShadow: paneShadow,
          padding: '22px 24px 40px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 22,
        }}
      >
        <button
          onClick={onClose}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          aria-label="Close"
          title="Close (Esc)"
          style={{
            position: 'absolute', top: 18, right: 18, width: 26, height: 26, borderRadius: 8, border: 'none',
            background: closeHover ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)',
            color: TEXT_QUIET, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s ease',
          }}
        >
          <XIcon />
        </button>

        {loading && <div style={{ padding: '40px 0' }}><CayeLoadingPulse size={16} /></div>}
        {error && <p style={{ fontSize: 13, color: '#fb7185' }}>{error}</p>}
        {!loading && !error && !person && <p style={{ fontSize: 13, color: TEXT_QUIET }}>Couldn't find this person.</p>}

        {person && (
          <>
            <div style={{ paddingRight: 30 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-display)', margin: '0 0 3px' }}>{person.name}</h2>
              {person.company && person.company !== person.name && (
                <p style={{ fontSize: 13, color: TEXT_QUIET, margin: '0 0 6px' }}>{person.company}</p>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{ color: person.needsYou ? GOLD : AQUA, fontWeight: 600 }}>{person.stateLabel}</span>
                {person.channel && (
                  <>
                    <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
                    <span style={{ color: TEXT_QUIET }}>{channelLabel(person.channel)}</span>
                  </>
                )}
                {person.lastInteractionAt && (
                  <>
                    <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
                    <span style={{ color: TEXT_QUIET }}>Last {formatDistanceToNow(person.lastInteractionAt)}</span>
                  </>
                )}
              </div>
            </div>

            {person.needsYou && (
              <div style={{ ...attentionSurface, borderRadius: 12, padding: '13px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: GOLD, boxShadow: `0 0 6px ${GOLD}88` }} />
                  <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD }}>Needs you</span>
                </div>
                <p style={{ fontSize: 13, color: TEXT, lineHeight: 1.5, margin: 0 }}>{person.needsYouReason}</p>
              </div>
            )}

            <section>
              <SectionLabel>Caye's understanding</SectionLabel>
              <p style={{ fontSize: 13.5, color: TEXT, lineHeight: 1.6, margin: 0, opacity: 0.92 }}>{person.understanding}</p>
            </section>

            <section>
              <SectionLabel>Current</SectionLabel>
              <p style={{ fontSize: 13.5, color: TEXT, lineHeight: 1.6, margin: '0 0 8px', opacity: 0.92 }}>{person.current}</p>
              <p style={{ fontSize: 12.5, color: TEXT_QUIET, margin: 0 }}>Next: {person.nextAction}</p>
            </section>

            {person.knownFacts.length > 0 && (
              <section>
                <SectionLabel>What Caye knows</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {person.knownFacts.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: AQUA, flexShrink: 0, marginTop: 6 }} />
                      <span style={{ fontSize: 13, color: TEXT, lineHeight: 1.5 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {person.whyFound && (
              <section>
                <SectionLabel>Why Caye found them</SectionLabel>
                <p style={{ fontSize: 13, color: TEXT, lineHeight: 1.6, margin: 0, opacity: 0.9 }}>{person.whyFound}</p>
              </section>
            )}

            {person.conversionValue && (
              <section>
                <SectionLabel>Value</SectionLabel>
                <p style={{ fontSize: 14, color: TEXT, fontWeight: 600, margin: 0 }}>{person.conversionValue}</p>
              </section>
            )}

            {person.history.length > 0 && (
              <section>
                <SectionLabel>History</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {[...person.history].reverse().map((h, i) => (
                    <div key={i} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : rowDivider, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 12.5, color: TEXT }}>{h.label}</span>
                      <span style={{ fontSize: 11.5, color: TEXT_QUIET, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                        {new Date(h.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {person.conversationId && (
              <button
                onClick={() => onReview(person.conversationId!)}
                style={{
                  alignSelf: 'flex-start', border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: 0, fontSize: 12.5, fontWeight: 600, color: AQUA,
                }}
              >
                View conversation →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
