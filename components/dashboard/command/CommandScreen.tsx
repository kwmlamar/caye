'use client'

import { useState, useEffect } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'

interface Escalation {
  id: string
  category: string | null
  route_to: string | null
  customer_facing_message: string | null
  internal_context: string | null
  created_at: string
  owner_responded_at: string | null
}

interface Overview {
  escalations: Escalation[]
  pending_escalation_count: number
  daily_cost: { day: string; cost_usd: number }[]
  total_cost_usd: number
  llm_call_count: number
}

// Founder-only: what Caye escalated for human judgment, and what she's
// costing to run, for the workspace currently in view. Read-only v1 —
// no reply-from-here action yet; that still happens over WhatsApp
// (back-office) or the Inbox tab, matching operator-tools-as-UI.
export default function CommandScreen() {
  const { workspaceId } = useWorkspace()
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      const { session } = await getSession()
      if (!session) {
        if (!cancelled) { setError('Not signed in'); setLoading(false) }
        return
      }
      try {
        const res = await fetch(`/api/founder/command-overview?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Failed to load')
        if (!cancelled) setData(json)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [workspaceId])

  if (loading) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tc-ink-mute)' }}>
        Loading…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tc-coral-deep)' }}>
        {error || 'Something went wrong'}
      </div>
    )
  }

  const maxDaily = Math.max(0.0001, ...data.daily_cost.map((d) => d.cost_usd))

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── Stat strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--tc-bg-app)', border: '1px solid var(--tc-line)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tc-ink-faint)' }}>
            Needs review
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: data.pending_escalation_count > 0 ? 'var(--tc-coral-deep)' : 'var(--tc-ink)', marginTop: 4 }}>
            {data.pending_escalation_count}
          </div>
        </div>
        <div style={{ background: 'var(--tc-bg-app)', border: '1px solid var(--tc-line)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tc-ink-faint)' }}>
            7-day spend
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--tc-ink)', marginTop: 4 }}>
            ${data.total_cost_usd.toFixed(2)}
          </div>
        </div>
      </div>

      {/* ── Cost trend ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tc-ink-mute)', marginBottom: 8 }}>
          Daily spend ({data.llm_call_count} calls this week)
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 60 }}>
          {data.daily_cost.map((d) => (
            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div
                title={`${d.day}: $${d.cost_usd.toFixed(4)}`}
                style={{
                  width: '100%',
                  height: Math.max(3, (d.cost_usd / maxDaily) * 44),
                  background: 'var(--tc-teal)',
                  borderRadius: 3,
                }}
              />
              <span style={{ fontSize: 9, color: 'var(--tc-ink-faint)' }}>
                {d.day.slice(5)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Escalations ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tc-ink-mute)', marginBottom: 8 }}>
          Escalations
        </div>
        {data.escalations.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--tc-ink-faint)' }}>Nothing escalated recently.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.escalations.map((e) => (
              <div
                key={e.id}
                style={{
                  border: '1px solid var(--tc-line)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  background: e.owner_responded_at ? 'var(--tc-bg-app)' : 'var(--tc-coral-soft)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tc-ink-mute)' }}>
                    {e.category || 'general'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--tc-ink-faint)' }}>
                    {formatDistanceToNow(e.created_at)}
                  </span>
                </div>
                {e.internal_context && (
                  <p style={{ fontSize: 13, color: 'var(--tc-ink)', marginTop: 4, lineHeight: 1.4 }}>
                    {e.internal_context}
                  </p>
                )}
                {!e.owner_responded_at && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--tc-coral-deep)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
