'use client'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

export interface Decision {
  id: string
  title: string
  description: string
  imageUrl?: string
  onApprove: () => void
  onDecline: () => void
  onChange?: () => void
}

/**
 * "Caye handles work autonomously and only interrupts the founder when
 * human judgment is actually needed" — but no backend concept of that
 * interrupt exists yet. Checked: caye_pending_operations
 * (supabase/migrations/20260811b_caye_pending_operations.sql) is a fully
 * automatic retry outbox for external effects (Zoho calendar sync today),
 * not a human-approval gate — nothing anywhere stages a decision and
 * waits on Approve/Decline/Change it.
 *
 * This is the clean shape for when that exists: nothing currently
 * constructs a `Decision`, so `decisions` is always `[]` and this renders
 * nothing. Do not backfill fake decisions to make this visible — wire a
 * real source (the natural first candidate is a queue next to
 * caye_pending_operations, gated on actually needing a human) and pass it
 * in here instead.
 */
export default function DecisionRequired({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) return null
  const d = decisions[0]

  return (
    <div style={{
      flexShrink: 0, background: '#1a1a1e', borderRadius: 16, border: `1px solid ${CARD_BORDER}`,
      padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: '#FFE4AF' }} />
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase', color: '#FFE4AF',
        }}>
          {decisions.length} decision{decisions.length === 1 ? '' : 's'} required
        </span>
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: '#f4f4f5', lineHeight: 1.4 }}>{d.title}</div>
      {d.imageUrl && (
        <img src={d.imageUrl} alt="" style={{ width: '100%', borderRadius: 10, display: 'block' }} />
      )}
      <p style={{ fontSize: 12.5, color: LABEL_COLOR, lineHeight: 1.55, margin: 0 }}>{d.description}</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          onClick={d.onApprove}
          style={{
            flex: 1, padding: '9px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600, color: '#111113',
            background: 'linear-gradient(90deg, #4EBECE, #FFE4AF)',
          }}
        >
          Approve
        </button>
        <button
          onClick={d.onDecline}
          style={{
            flex: 1, padding: '9px 0', borderRadius: 9, cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600, color: '#a1a1aa',
            background: 'transparent', border: `1px solid ${CARD_BORDER}`,
          }}
        >
          Decline
        </button>
        {d.onChange && (
          <button
            onClick={d.onChange}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 9, cursor: 'pointer',
              fontSize: 12.5, fontWeight: 600, color: '#a1a1aa',
              background: 'transparent', border: `1px solid ${CARD_BORDER}`,
            }}
          >
            Change it
          </button>
        )}
      </div>
    </div>
  )
}
