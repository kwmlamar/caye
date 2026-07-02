'use client'

import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import { formatDistanceToNow } from '@/lib/utils'

// Same mesh-gradient palette as the landing hero / CayeMark orb — used
// sparingly here as accent lines and the cost bars, not painted over
// every element (minimal, per the 2026-07-01 redesign).
const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

// Founder-only: what Caye escalated for human judgment, and what she's
// costing to run, for the workspace currently in view. Read-only v1 —
// no reply-from-here action yet; that still happens over WhatsApp
// (back-office) or the Inbox tab, matching operator-tools-as-UI.
export default function CommandScreen() {
  const { workspaceId } = useWorkspace()
  const { data, loading, error } = useCommandOverview(workspaceId)

  if (loading) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'rgba(245,245,244,0.5)' }}>
        Loading…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: '#ff8a6b' }}>
        {error || 'Something went wrong'}
      </div>
    )
  }

  const maxDaily = Math.max(0.0001, ...data.daily_cost.map((d) => d.cost_usd))

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* ── Stat strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>
            Needs review
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: data.pending_escalation_count > 0 ? '#ff8a6b' : '#f5f5f4', marginTop: 4 }}>
            {data.pending_escalation_count}
          </div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(245,245,244,0.4)' }}>
            7-day spend
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#f5f5f4', marginTop: 4 }}>
            ${data.total_cost_usd.toFixed(2)}
          </div>
        </div>
      </div>

      {/* ── Cost trend ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(245,245,244,0.5)', marginBottom: 10 }}>
          Daily spend · {data.llm_call_count} calls this week
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 56 }}>
          {data.daily_cost.map((d) => (
            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div
                title={`${d.day}: $${d.cost_usd.toFixed(4)}`}
                style={{
                  width: '100%',
                  height: Math.max(3, (d.cost_usd / maxDaily) * 40),
                  background: GRADIENT,
                  borderRadius: 3,
                  opacity: d.cost_usd > 0 ? 1 : 0.15,
                }}
              />
              <span style={{ fontSize: 9, color: 'rgba(245,245,244,0.35)' }}>
                {d.day.slice(5)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Escalations ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(245,245,244,0.5)', marginBottom: 10 }}>
          Escalations
        </div>
        {data.escalations.length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgba(245,245,244,0.35)' }}>Nothing escalated recently.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.escalations.map((e) => (
              <div
                key={e.id}
                style={{
                  border: `1px solid ${e.owner_responded_at ? 'rgba(255,255,255,0.08)' : 'rgba(255,138,107,0.3)'}`,
                  borderRadius: 12,
                  padding: '10px 12px',
                  background: e.owner_responded_at ? 'rgba(255,255,255,0.03)' : 'rgba(255,138,107,0.08)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'rgba(245,245,244,0.55)' }}>
                    {e.category || 'general'}
                  </span>
                  <span style={{ fontSize: 11, color: 'rgba(245,245,244,0.35)' }}>
                    {formatDistanceToNow(e.created_at)}
                  </span>
                </div>
                {e.internal_context && (
                  <p style={{ fontSize: 13, color: '#f5f5f4', marginTop: 4, lineHeight: 1.4 }}>
                    {e.internal_context}
                  </p>
                )}
                {!e.owner_responded_at && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#ff8a6b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Needs response
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
