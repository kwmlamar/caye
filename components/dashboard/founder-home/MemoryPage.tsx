'use client'

import { useState, useEffect, useMemo } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import { TEXT, TEXT_QUIET } from '../surface'
import MemoryOverview from './memory/MemoryOverview'
import MemoryItem, { type MemoryItemData } from './memory/MemoryItem'
import { CATEGORY_LABEL, CATEGORY_ORDER, type MemoryData, type Fact, type Rule, type Candidate } from './memory/types'

function useMemoryData(workspaceId: string) {
  const [data, setData] = useState<MemoryData | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    async function load() {
      const { session } = await getSession()
      if (!session || cancelled) return
      const res = await fetch(`/api/founder/memory?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok || cancelled) return
      const json = await res.json()
      setData({ facts: json.facts ?? [], rules: json.rules ?? [], candidates: json.candidates ?? [] })
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  return data
}

// ── Real-field-only display logic — nothing here invents content, it
// only composes what's already in the row. See memory/types.ts for the
// exact backend fields each of these reads. ──

function ruleSentence(r: Rule): string {
  const routeLabel = r.route_to === 'both' ? 'the owner and founder' : r.route_to === 'founder' ? 'the founder' : 'the owner'
  const trigger = r.trigger_type === 'service_mention' ? `mentions "${r.match_value}"` : `includes the phrase "${r.match_value}"`
  return `When a customer's message ${trigger}, Caye escalates to ${routeLabel} instead of answering on her own.`
}

function ruleToItem(r: Rule): MemoryItemData {
  return {
    id: r.id,
    text: ruleSentence(r),
    tone: 'gold',
    metaLeft: r.is_active ? undefined : 'Turned off',
    metaRight: r.times_fired > 0 ? `Triggered ${r.times_fired} time${r.times_fired === 1 ? '' : 's'}` : 'Never triggered',
    technical: [
      { label: 'ID', value: r.id },
      { label: 'Trigger type', value: r.trigger_type },
      { label: 'Match value', value: r.match_value },
      { label: 'Action', value: r.action },
      { label: 'Route to', value: r.route_to },
      { label: 'Active', value: String(r.is_active) },
      { label: 'Times fired', value: String(r.times_fired) },
      { label: 'Last fired', value: r.last_fired_at ? formatDistanceToNow(r.last_fired_at) : '—' },
    ],
  }
}

function factProvenance(f: Fact): string {
  if (f.source === 'candidate-confirmed') {
    return f.learned_occurrence_count
      ? `Learned from ${f.learned_occurrence_count} conversation${f.learned_occurrence_count === 1 ? '' : 's'}`
      : 'Learned from repeated conversations'
  }
  if (f.source === 'escalation-capture') return 'Learned from an escalation'
  return 'Taught directly'
}

function factToItem(f: Fact): MemoryItemData {
  return {
    id: f.id,
    text: f.fact,
    tone: 'neutral',
    metaLeft: factProvenance(f),
    metaRight: formatDistanceToNow(f.created_at),
    technical: [
      { label: 'ID', value: f.id },
      { label: 'Category', value: f.category },
      { label: 'Source', value: f.source },
      { label: 'Created', value: new Date(f.created_at).toLocaleString() },
    ],
  }
}

function candidateToItem(c: Candidate): MemoryItemData {
  return {
    id: c.id,
    text: c.sample_text,
    tone: 'gold',
    metaLeft: `Noticed in ${c.occurrence_count} conversation${c.occurrence_count === 1 ? '' : 's'} · awaiting your answer`,
    metaRight: formatDistanceToNow(c.first_seen_at),
    technical: [
      { label: 'ID', value: c.id },
      { label: 'Category guess', value: c.category_guess },
      { label: 'Occurrences', value: String(c.occurrence_count) },
      { label: 'First seen', value: new Date(c.first_seen_at).toLocaleString() },
      { label: 'Proposed', value: c.proposed_at ? new Date(c.proposed_at).toLocaleString() : '—' },
    ],
  }
}

type Filter = 'all' | 'rules' | 'knowledge' | 'learned' | 'clarify'

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q.toLowerCase())
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: TEXT_QUIET, marginBottom: 10 }}>
      {children}
    </div>
  )
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
        fontSize: 11.5, fontWeight: 600,
        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
        color: active ? TEXT : TEXT_QUIET,
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}

/**
 * "What does my employee understand about my business" — not a config
 * viewer. Read-only, matching ContactsPanel's "lens, not an editor"
 * convention: teaching Caye something new (add_business_fact, standing
 * rule creation, confirming a proposed pattern) stays a conversation with
 * her, via the global Ask Caye composer. Nothing here edits or deletes.
 */
export default function MemoryPage({ workspaceId }: { workspaceId: string }) {
  const data = useMemoryData(workspaceId)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  // Workspace switches don't remount this page (see FounderHome's
  // view-swap key, which is keyed on rail, not workspace) — reset local
  // UI state explicitly so a search/filter from the previous workspace
  // doesn't linger into this one.
  useEffect(() => {
    setQuery('')
    setFilter('all')
  }, [workspaceId])

  const learnedFacts = useMemo(() => (data?.facts ?? []).filter((f) => f.source === 'candidate-confirmed'), [data])
  const knowledgeFacts = useMemo(() => (data?.facts ?? []).filter((f) => f.source !== 'candidate-confirmed'), [data])
  const knowledgeByCategory = useMemo(
    () => CATEGORY_ORDER.map((cat) => ({ cat, items: knowledgeFacts.filter((f) => f.category === cat) })).filter((g) => g.items.length > 0),
    [knowledgeFacts]
  )

  const q = query.trim()
  const showRules = filter === 'all' || filter === 'rules'
  const showKnowledge = filter === 'all' || filter === 'knowledge'
  const showLearned = filter === 'all' || filter === 'learned'
  const showClarify = filter === 'all' || filter === 'clarify'

  const filteredRules = data && showRules ? data.rules.filter((r) => !q || matches(ruleSentence(r), q)) : []
  const filteredKnowledge = showKnowledge
    ? knowledgeByCategory.map((g) => ({ ...g, items: g.items.filter((f) => !q || matches(f.fact, q) || matches(CATEGORY_LABEL[g.cat], q)) })).filter((g) => g.items.length > 0)
    : []
  const filteredLearned = showLearned ? learnedFacts.filter((f) => !q || matches(f.fact, q)) : []
  const filteredCandidates = data && showClarify ? data.candidates.filter((c) => !q || matches(c.sample_text, q)) : []

  const loading = data === null
  const totallyEmpty = data && data.facts.length === 0 && data.rules.length === 0 && data.candidates.length === 0
  const noSearchResults = !totallyEmpty && data && q
    && filteredRules.length === 0 && filteredKnowledge.length === 0 && filteredLearned.length === 0 && filteredCandidates.length === 0

  return (
    // paddingBottom clears the floating global Ask Caye composer.
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 110px' }}>
      <div style={{ maxWidth: 780 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>Memory</h1>
        <p style={{ fontSize: 13.5, color: TEXT_QUIET, margin: '0 0 4px', lineHeight: 1.6 }}>
          What Caye knows about this business.
        </p>
        <p style={{ fontSize: 13.5, color: TEXT_QUIET, margin: '0 0 28px', lineHeight: 1.6 }}>
          Want her to remember something? Ask Caye below — for example,
          <span style={{ color: 'rgba(245,245,244,0.55)', fontStyle: 'italic' }}> "Remember that private tours require a 50% deposit."</span>
        </p>

        {loading ? (
          <CayeLoadingPulse label="LOADING" size={16} />
        ) : totallyEmpty ? (
          <div style={{ padding: '32px 4px' }}>
            <p style={{ fontSize: 14, color: TEXT, lineHeight: 1.6, margin: '0 0 6px', fontWeight: 600 }}>Caye is still learning this business.</p>
            <p style={{ fontSize: 13.5, color: TEXT_QUIET, lineHeight: 1.6, margin: 0 }}>
              Teach her how things work by talking to Caye — policies, pricing, rules she should always follow.
              Everything she learns will show up here.
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 26 }}>
              <MemoryOverview data={data} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180, maxWidth: 320 }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search what Caye knows…"
                  aria-label="Search what Caye knows"
                  style={{
                    width: '100%', background: 'rgba(255,255,255,0.032)', border: 'none',
                    borderRadius: 999, padding: '7px 14px', fontSize: 12.5, color: TEXT, outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <FilterPill label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
                {data.rules.length > 0 && <FilterPill label="Rules" active={filter === 'rules'} onClick={() => setFilter('rules')} />}
                {knowledgeFacts.length > 0 && <FilterPill label="Knowledge" active={filter === 'knowledge'} onClick={() => setFilter('knowledge')} />}
                {learnedFacts.length > 0 && <FilterPill label="Learned" active={filter === 'learned'} onClick={() => setFilter('learned')} />}
                {data.candidates.length > 0 && <FilterPill label="Needs clarification" active={filter === 'clarify'} onClick={() => setFilter('clarify')} />}
              </div>
            </div>

            {noSearchResults ? (
              <p style={{ fontSize: 13, color: TEXT_QUIET, padding: '12px 4px' }}>Nothing matches "{q}".</p>
            ) : (
              <>
                {showClarify && filteredCandidates.length > 0 && (
                  <section style={{ marginBottom: 30 }}>
                    <SectionLabel>Needs clarification</SectionLabel>
                    <div>
                      {filteredCandidates.map((c, i) => <MemoryItem key={c.id} item={candidateToItem(c)} first={i === 0} />)}
                    </div>
                  </section>
                )}

                {showRules && filteredRules.length > 0 && (
                  <section style={{ marginBottom: 30 }}>
                    <SectionLabel>Standing rules — enforced, not advisory</SectionLabel>
                    <div>
                      {filteredRules.map((r, i) => <MemoryItem key={r.id} item={ruleToItem(r)} first={i === 0} />)}
                    </div>
                  </section>
                )}

                {showLearned && filteredLearned.length > 0 && (
                  <section style={{ marginBottom: 30 }}>
                    <SectionLabel>Learned from experience</SectionLabel>
                    <div>
                      {filteredLearned.map((f, i) => <MemoryItem key={f.id} item={factToItem(f)} first={i === 0} />)}
                    </div>
                  </section>
                )}

                {showKnowledge && filteredKnowledge.map(({ cat, items }) => (
                  <section key={cat} style={{ marginBottom: 30 }}>
                    <SectionLabel>{CATEGORY_LABEL[cat]}</SectionLabel>
                    <div>
                      {items.map((f, i) => <MemoryItem key={f.id} item={factToItem(f)} first={i === 0} />)}
                    </div>
                  </section>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
