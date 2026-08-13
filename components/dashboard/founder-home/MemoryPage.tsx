'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import { rowDivider, TEXT_QUIET } from '../surface'

const LABEL_COLOR = TEXT_QUIET

interface Fact {
  id: string
  category: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  fact: string
  source: string
  created_at: string
}
interface Rule {
  id: string
  trigger_type: 'service_mention' | 'keyword'
  match_value: string
  action: string
  route_to: string
  is_active: boolean
  times_fired: number
  last_fired_at: string | null
}

const CATEGORY_LABEL: Record<Fact['category'], string> = {
  policy: 'Policies', service_detail: 'Service details', special_handling: 'Special handling', logistics: 'Logistics',
}
const CATEGORY_ORDER: Fact['category'][] = ['policy', 'service_detail', 'special_handling', 'logistics']

function useMemoryData(workspaceId: string) {
  const [facts, setFacts] = useState<Fact[] | null>(null)
  const [rules, setRules] = useState<Rule[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setFacts(null)
    setRules(null)
    async function load() {
      const { session } = await getSession()
      if (!session || cancelled) return
      const res = await fetch(`/api/founder/memory?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok || cancelled) return
      const json = await res.json()
      setFacts(json.facts ?? [])
      setRules(json.rules ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  return { facts, rules }
}

/**
 * What Caye actually knows about this business — read-only, matching
 * ContactsPanel's "lens, not an editor" convention. Teaching Caye
 * something new (add_business_fact, standing rule creation) stays a
 * WhatsApp action; this is where the founder checks what stuck.
 */
export default function MemoryPage({ workspaceId }: { workspaceId: string }) {
  const { facts, rules } = useMemoryData(workspaceId)
  const loading = facts === null || rules === null

  const byCategory = facts
    ? CATEGORY_ORDER.map((cat) => ({ cat, items: facts.filter((f) => f.category === cat) })).filter((g) => g.items.length > 0)
    : []

  return (
    // paddingBottom clears the floating global composer.
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 96px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>Memory</h1>
      <p style={{ fontSize: 13, color: LABEL_COLOR, margin: '0 0 28px' }}>
        What Caye has learned about this business. Teach her something new by messaging her — nothing here is editable.
      </p>

      {loading ? (
        <CayeLoadingPulse label="LOADING" size={16} />
      ) : (
        <>
          {rules && rules.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 12 }}>
                Standing rules — enforced, not advisory
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rules.map((r, i) => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px',
                    borderTop: i === 0 ? 'none' : rowDivider,
                  }}>
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: r.is_active ? '#34d399' : '#52525b', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: '#f4f4f5' }}>
                        {r.trigger_type === 'service_mention' ? 'Mentions' : 'Says'} <strong>“{r.match_value}”</strong> → escalate to {r.route_to}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: LABEL_COLOR, flexShrink: 0 }}>
                      {r.times_fired > 0 ? `fired ${r.times_fired}×` : 'never fired'}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {byCategory.length === 0 && (!rules || rules.length === 0) ? (
            <p style={{ fontSize: 13, color: LABEL_COLOR }}>Nothing taught yet — Caye learns from conversations and from what you tell her directly.</p>
          ) : (
            byCategory.map(({ cat, items }) => (
              <section key={cat} style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 12 }}>
                  {CATEGORY_LABEL[cat]}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {items.map((f, i) => (
                    <div key={f.id} style={{
                      padding: '11px 4px', borderTop: i === 0 ? 'none' : rowDivider,
                      fontSize: 13.5, color: '#e4e4e7', lineHeight: 1.5,
                    }}>
                      {f.fact}
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
