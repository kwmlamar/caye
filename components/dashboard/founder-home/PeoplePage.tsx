'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePeople } from '@/lib/usePeople'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import { TEXT, TEXT_QUIET } from '../surface'
import PeopleOverview from './people/PeopleOverview'
import PersonRow from './people/PersonRow'
import PersonPanel from './people/PersonPanel'
import type { PersonSummary } from '@/lib/people'

type Filter = 'all' | 'customers' | 'new' | 'engaged' | 'in_progress' | 'needs_you'
const IN_PROGRESS_STATES = new Set(['researching', 'ready', 'contacted', 'tried_demo'])

function matchesFilter(p: PersonSummary, filter: Filter, isSales: boolean): boolean {
  if (filter === 'all') return true
  if (filter === 'needs_you') return p.needsYou
  if (isSales) {
    if (filter === 'engaged') return p.state === 'engaged' || p.state === 'converted'
    if (filter === 'in_progress') return IN_PROGRESS_STATES.has(p.state)
  } else {
    if (filter === 'customers') return p.state === 'customer' || p.state === 'returning_customer'
    if (filter === 'new') return p.state === 'new_contact'
  }
  return true
}

function matchesQuery(p: PersonSummary, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    p.name.toLowerCase().includes(needle) ||
    (p.company?.toLowerCase().includes(needle) ?? false) ||
    (p.email?.toLowerCase().includes(needle) ?? false) ||
    (p.phone?.toLowerCase().includes(needle) ?? false)
  )
}

function FilterPill({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600,
        background: active ? 'rgba(255,255,255,0.1)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        color: active ? TEXT : TEXT_QUIET,
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {label}
      {count > 0 && (
        <span aria-hidden style={{
          fontSize: 10, fontWeight: 700, color: 'rgba(245,245,244,0.55)', background: 'rgba(255,255,255,0.08)',
          borderRadius: 999, padding: '1px 6px',
        }}>
          {count}
        </span>
      )}
    </button>
  )
}

function SearchIcon({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

/**
 * "These are the people Caye knows through your business, and this is her
 * understanding of every relationship" — not a contact database. Replaces
 * ContactsPanel.tsx wholesale (2026-08-13 redesign); see lib/people.ts and
 * app/api/founder/people/route.ts for the architecture behind it — one
 * normalized shape fed by contacts (customer-facing workspaces) or
 * outreach_leads (internal_sales), which don't share an identity model.
 */
export default function PeoplePage({ workspaceId, onReviewConversation }: {
  workspaceId: string
  onReviewConversation: (conversationId: string) => void
}) {
  const { people, workspaceKind, loading, error } = usePeople(workspaceId)
  const isSales = workspaceKind === 'internal_sales'
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Workspace switches don't remount this page — reset local UI state so a
  // filter/search from the previous workspace doesn't linger into this one.
  useEffect(() => {
    setQuery('')
    setFilter('all')
    setSelectedId(null)
  }, [workspaceId])

  const filtered = useMemo(() => {
    if (!people) return []
    const q = query.trim()
    return people.filter((p) => matchesFilter(p, filter, isSales) && (!q || matchesQuery(p, q)))
  }, [people, filter, isSales, query])

  const counts = useMemo(() => {
    if (!people) return { customers: 0, new: 0, engaged: 0, inProgress: 0, needsYou: 0 }
    return {
      customers: people.filter((p) => p.state === 'customer' || p.state === 'returning_customer').length,
      new: people.filter((p) => p.state === 'new_contact').length,
      engaged: people.filter((p) => p.state === 'engaged' || p.state === 'converted').length,
      inProgress: people.filter((p) => IN_PROGRESS_STATES.has(p.state)).length,
      needsYou: people.filter((p) => p.needsYou).length,
    }
  }, [people])

  return (
    // paddingBottom clears the floating global Ask Caye composer.
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 110px' }}>
      <div style={{ maxWidth: 780 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>People</h1>
        <p style={{ fontSize: 13.5, color: TEXT_QUIET, margin: '0 0 28px', lineHeight: 1.6 }}>
          {isSales ? 'Everyone Caye is working through your outbound market.' : 'Everyone Caye knows through your business.'}
        </p>

        {loading ? (
          <CayeLoadingPulse label="LOADING" size={16} />
        ) : error ? (
          <p style={{ fontSize: 13, color: '#fb7185' }}>{error}</p>
        ) : !people || people.length === 0 ? (
          <div style={{ padding: '32px 4px' }}>
            <p style={{ fontSize: 14, color: TEXT, lineHeight: 1.6, margin: '0 0 6px', fontWeight: 600 }}>
              {isSales ? "Caye hasn't sourced any prospects yet." : 'No one yet.'}
            </p>
            <p style={{ fontSize: 13.5, color: TEXT_QUIET, lineHeight: 1.6, margin: 0 }}>
              {isSales
                ? 'Once autonomous sourcing runs, prospects will show up here as Caye finds and works them.'
                : 'People appear here automatically once guests message this business on WhatsApp, Instagram, Messenger, or email.'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 26 }}>
              <PeopleOverview people={people} isSales={isSales} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180, maxWidth: 320 }}>
                <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', display: 'flex', pointerEvents: 'none' }}>
                  <SearchIcon color={searchFocused ? 'rgba(78,190,206,0.9)' : 'rgba(245,245,244,0.3)'} />
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  placeholder="Search people…"
                  aria-label="Search people"
                  style={{
                    width: '100%', background: 'rgba(255,255,255,0.032)', border: 'none',
                    borderRadius: 999, padding: '7px 14px 7px 30px', fontSize: 12.5, color: TEXT, outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <FilterPill label="All" count={0} active={filter === 'all'} onClick={() => setFilter('all')} />
                {isSales ? (
                  <>
                    <FilterPill label="Engaged" count={counts.engaged} active={filter === 'engaged'} onClick={() => setFilter('engaged')} />
                    <FilterPill label="In progress" count={counts.inProgress} active={filter === 'in_progress'} onClick={() => setFilter('in_progress')} />
                  </>
                ) : (
                  <>
                    <FilterPill label="Customers" count={counts.customers} active={filter === 'customers'} onClick={() => setFilter('customers')} />
                    <FilterPill label="New" count={counts.new} active={filter === 'new'} onClick={() => setFilter('new')} />
                  </>
                )}
                {counts.needsYou > 0 && (
                  <FilterPill label="Needs you" count={counts.needsYou} active={filter === 'needs_you'} onClick={() => setFilter('needs_you')} />
                )}
              </div>
            </div>

            {filtered.length === 0 ? (
              <p style={{ fontSize: 13, color: TEXT_QUIET, padding: '12px 4px' }}>
                {query ? `Nothing matches "${query}".` : 'Nothing in this filter.'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {filtered.map((p) => (
                  <PersonRow key={p.id} person={p} active={selectedId === p.id} onClick={() => setSelectedId(p.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {selectedId && (
        <PersonPanel
          workspaceId={workspaceId}
          personId={selectedId}
          onClose={() => setSelectedId(null)}
          onReview={(conversationId) => { setSelectedId(null); onReviewConversation(conversationId) }}
        />
      )}
    </div>
  )
}
