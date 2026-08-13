'use client'

import AskCayeComposer from './AskCayeComposer'

/**
 * "Ask Caye anything…" — closer to messaging an employee than a generic
 * chatbot input because it IS that: submitting hands the text to the real
 * Caye Direct thread (same back-office agent operators text over
 * WhatsApp), not a separate composer with its own fake reply logic. See
 * FounderHome's `talkToCayeDraft` state, which expands the Caye Direct
 * panel and passes this straight through to CayeDirectThread's
 * initialMessage.
 *
 * The always-expanded, always-visible form — Home, Work, People, Memory,
 * Settings. On Inbox this competes with the customer reply composer for
 * bottom-of-screen real estate, so FounderHome swaps this out for
 * CayeLauncher there instead (compact until clicked). Both render the
 * same AskCayeComposer pill so the visual language never diverges.
 *
 * No mic/voice affordance — WhatsApp voice calling is "idea, not started"
 * (voice-calling-roadmap.md), so nothing here pretends otherwise.
 */
export default function TalkToCaye({ onSend, onOpenHistory, busy }: {
  onSend: (text: string) => void
  onOpenHistory?: () => void
  busy?: boolean
}) {
  return (
    // pointerEvents:auto re-enables interaction here — the parent wrapper
    // (FounderHome) sets pointerEvents:none on itself so the transparent
    // margin around this centered pill never blocks a click on whatever's
    // visible through it; this root is where clicks start working again.
    <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '4px 0 2px', background: 'transparent', pointerEvents: 'auto' }}>
      <AskCayeComposer onSend={onSend} onOpenHistory={onOpenHistory} busy={busy} />
    </div>
  )
}
