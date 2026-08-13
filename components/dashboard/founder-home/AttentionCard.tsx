'use client'

import type { Escalation } from '@/lib/useCommandOverview'

const GOLD = '#FFE4AF'

/**
 * "Surface the decision, not merely its existence." Open caye_escalations
 * rows already ARE real founder decisions — a customer asked something
 * Caye didn't want to guess about — so this reads the real record
 * (internal_context: why she escalated) rather than a generic count.
 * Renders nothing when there's genuinely nothing open: the interface
 * should relax, not show an empty "Needs Review: 0" card.
 */
export default function AttentionCard({ escalations, onReview }: {
  escalations: Escalation[]
  onReview: (conversationId: string | null) => void
}) {
  const open = escalations
    .filter((e) => !e.owner_responded_at && !e.expired_at)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  if (open.length === 0) return null
  const primary = open[0]
  const detail = primary.internal_context
    || primary.customer_facing_message
    || (primary.category ? `Something about ${primary.category} I'd rather not guess on.` : "Something I'd rather not guess on.")

  return (
    <div style={{
      background: 'rgba(255,228,175,0.05)', border: '1px solid rgba(255,228,175,0.22)', borderRadius: 16,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 440,
      animation: 'caye-view-in 0.25s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: GOLD }} />
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD }}>
          Needs you{open.length > 1 ? ` · +${open.length - 1} more` : ''}
        </span>
      </div>
      <p style={{ fontSize: 14, color: '#e4e4e7', lineHeight: 1.5, margin: 0 }}>{detail}</p>
      <button
        onClick={() => onReview(primary.conversation_id)}
        style={{
          alignSelf: 'flex-start', padding: '7px 15px', borderRadius: 9, border: 'none', cursor: 'pointer',
          fontSize: 12.5, fontWeight: 600, color: '#111113', background: GOLD,
        }}
      >
        Review
      </button>
    </div>
  )
}
