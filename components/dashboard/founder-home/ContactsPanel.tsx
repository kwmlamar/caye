'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from '@/lib/utils'
import { useWorkspaceContacts } from '@/lib/useWorkspaceContacts'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import type { Contact } from '@/types/database'

// Same dark-console tokens as FounderHome.tsx — kept local rather than
// imported since FounderHome doesn't export them.
const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WA',
  instagram: 'IG',
  messenger: 'FB',
  email: 'Mail',
  sms: 'SMS',
}
// Same channel palette as CommandConversations.tsx — one color vocabulary
// for a channel across the whole founder console.
const CHANNEL_COLOR: Record<string, string> = {
  whatsapp: '#22c55e',
  email: '#4EBECE',
  instagram: '#FFE4AF',
  messenger: '#4EBECE',
  sms: 'rgba(245,245,244,0.5)',
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

function SearchIcon({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function XIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  )
}

function TabPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
        fontSize: 11, fontWeight: 600,
        background: active ? '#f5f5f4' : hover ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.06)',
        color: active ? '#0a0a0b' : hover ? 'rgba(245,245,244,0.85)' : 'rgba(245,245,244,0.55)',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}

function StatTile({ label, value, valueColor = '#f4f4f5' }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ background: CARD_BG, borderRadius: 18, padding: '16px 18px' }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, color: valueColor, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

// Borderless flat tint — same treatment as the sidebar's workspace
// initial badges (FounderHome's collapsed-rail buttons), just circular
// instead of rounded-square to read as a person rather than a workspace.
function Avatar({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <div style={{
      width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(78,190,206,0.16)',
      color: '#4EBECE', fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-display)',
    }}>
      {initial}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: '#e4e4e7' }}>{value}</span>
    </div>
  )
}

function ContactDetail({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const [closeHover, setCloseHover] = useState(false)
  const facts = contact.ai_contact_facts
  const factLines: string[] = []
  if (facts?.dietary?.length) factLines.push(`Dietary: ${facts.dietary.join(', ')}`)
  if (facts?.mobility?.length) factLines.push(`Mobility: ${facts.mobility.join(', ')}`)
  if (facts?.group_composition) factLines.push(`Group: ${facts.group_composition}`)
  if (facts?.preferences?.length) factLines.push(`Preferences: ${facts.preferences.join(', ')}`)
  if (facts?.occasions?.length) factLines.push(`Occasions: ${facts.occasions.join(', ')}`)

  // Esc closes the flyout — matches the fullscreen-panel Esc convention
  // elsewhere in FounderHome, applied locally since this overlay isn't
  // wired into that top-level `expanded` state.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    // `fixed`, not `absolute` — the list column this renders inside
    // scrolls, so an `absolute inset:0` backdrop only covers that
    // column's own viewport-height box: scroll down and the backdrop
    // scrolls up with it, leaving the freshly-revealed rows below
    // undimmed. `fixed` pins the whole drawer (backdrop + panel) to the
    // viewport regardless of any ancestor's scroll position.
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(9,9,11,0.75)',
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 50,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, maxWidth: '100%', background: CARD_BG, boxShadow: '-24px 0 48px rgba(0,0,0,0.35)',
          padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Avatar name={contact.name ?? contact.phone_number ?? contact.channel_id ?? '?'} />
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: '#f4f4f5',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {contact.name ?? contact.phone_number ?? contact.channel_id ?? 'Unknown'}
              </div>
              <div style={{ marginTop: 2 }}>
                <Pill color={CHANNEL_COLOR[contact.channel_type ?? ''] ?? LABEL_COLOR} label={CHANNEL_LABEL[contact.channel_type ?? ''] ?? contact.channel_type ?? '—'} />
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
            aria-label="Close contact details"
            title="Close (Esc)"
            style={{
              flexShrink: 0, width: 26, height: 26, borderRadius: 8, border: 'none',
              background: closeHover ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.08)',
              color: '#a1a1aa', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
          >
            <XIcon />
          </button>
        </div>

        {(contact.is_blocked || contact.opted_out) && (
          <div style={{ display: 'flex', gap: 10 }}>
            {contact.is_blocked && <Pill label="Blocked" color="#fb7185" />}
            {contact.opted_out && <Pill label="Opted out" color="#fbbf24" />}
          </div>
        )}

        <DetailRow label="Phone" value={contact.phone_number ?? '—'} />
        <DetailRow label="Email" value={contact.email ?? '—'} />
        <DetailRow
          label="Messages"
          value={`${contact.total_messages_received} received / ${contact.total_messages_sent} sent`}
        />
        <DetailRow
          label="First message"
          value={contact.first_message_at ? formatDistanceToNow(contact.first_message_at) : '—'}
        />
        <DetailRow
          label="Last message"
          value={contact.last_message_at ? formatDistanceToNow(contact.last_message_at) : '—'}
        />

        {contact.ai_contact_profile && (
          <DetailRow
            label="Communication style"
            value={`${contact.ai_contact_profile.formality} / ${contact.ai_contact_profile.message_style}${
              contact.ai_contact_profile.language_notes ? ` — ${contact.ai_contact_profile.language_notes}` : ''
            }`}
          />
        )}

        {factLines.length > 0 && <DetailRow label="Known facts" value={factLines.join(' · ')} />}

        {!contact.ai_contact_profile && factLines.length === 0 && (
          <p style={{ fontSize: 12, color: LABEL_COLOR, lineHeight: 1.5 }}>
            No AI-derived profile yet — Caye builds this after a few inbound messages from this contact.
          </p>
        )}

        {contact.notes && <DetailRow label="Notes" value={contact.notes} />}
      </div>
    </div>
  )
}

function ContactRow({ contact, onClick }: { contact: Contact; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const displayName = contact.name ?? contact.phone_number ?? contact.channel_id ?? 'Unknown'
  const channelColor = CHANNEL_COLOR[contact.channel_type ?? ''] ?? LABEL_COLOR
  const channelLabel = CHANNEL_LABEL[contact.channel_type ?? ''] ?? contact.channel_type ?? '—'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: '10px 14px', borderRadius: 12, cursor: 'pointer', border: 'none',
        background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      <Avatar name={displayName} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: '#f4f4f5',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {displayName}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: LABEL_COLOR, minWidth: 0 }}>
          <Pill color={channelColor} label={channelLabel} />
          {contact.last_message_at && <span style={{ flexShrink: 0 }}>· {formatDistanceToNow(contact.last_message_at)}</span>}
          <span style={{ flexShrink: 0 }}>· {contact.total_messages_received + contact.total_messages_sent} msgs</span>
        </div>
      </div>
      {(contact.is_blocked || contact.opted_out) && (
        <Pill
          label={contact.is_blocked ? 'Blocked' : 'Opted out'}
          color={contact.is_blocked ? '#fb7185' : '#fbbf24'}
        />
      )}
    </button>
  )
}

function ContactRowSkeleton({ delay }: { delay: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
      <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', animation: 'caye-skeleton-pulse 1.5s ease-in-out infinite', animationDelay: `${delay}s`, flexShrink: 0 }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ height: 12, width: '38%', borderRadius: 6, background: 'rgba(255,255,255,0.06)', animation: 'caye-skeleton-pulse 1.5s ease-in-out infinite', animationDelay: `${delay}s` }} />
        <div style={{ height: 10, width: '24%', borderRadius: 6, background: 'rgba(255,255,255,0.06)', animation: 'caye-skeleton-pulse 1.5s ease-in-out infinite', animationDelay: `${delay + 0.05}s` }} />
      </div>
    </div>
  )
}

export default function ContactsPanel({ workspaceId }: { workspaceId: string }) {
  const { contacts, loading, error } = useWorkspaceContacts(workspaceId)
  const [selected, setSelected] = useState<Contact | null>(null)
  const [tab, setTab] = useState<'all' | 'flagged'>('all')
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)

  const counts = useMemo(() => {
    if (!contacts) return { all: 0, flagged: 0, activeThisWeek: 0 }
    const now = Date.now()
    return {
      all: contacts.length,
      flagged: contacts.filter((c) => c.is_blocked || c.opted_out).length,
      activeThisWeek: contacts.filter((c) => c.last_message_at && now - new Date(c.last_message_at).getTime() < ONE_WEEK_MS).length,
    }
  }, [contacts])

  const filtered = useMemo(() => {
    if (!contacts) return []
    let list = tab === 'flagged' ? contacts.filter((c) => c.is_blocked || c.opted_out) : contacts
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((c) => {
        const name = (c.name ?? '').toLowerCase()
        const phone = (c.phone_number ?? '').toLowerCase()
        const email = (c.email ?? '').toLowerCase()
        return name.includes(q) || phone.includes(q) || email.includes(q)
      })
    }
    return list
  }, [contacts, tab, query])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <StatTile label="Contacts" value={contacts ? String(counts.all) : '—'} />
        <StatTile label="Active this week" value={contacts ? String(counts.activeThisWeek) : '—'} />
        <StatTile
          label="Flagged"
          value={contacts ? String(counts.flagged) : '—'}
          valueColor={counts.flagged > 0 ? '#fb7185' : '#f4f4f5'}
        />
      </div>

      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <TabPill label={`All${contacts ? ` (${counts.all})` : ''}`} active={tab === 'all'} onClick={() => setTab('all')} />
          <TabPill label={`Flagged${contacts ? ` (${counts.flagged})` : ''}`} active={tab === 'flagged'} onClick={() => setTab('flagged')} />
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: 240, maxWidth: '100%' }}>
          <span style={{ position: 'absolute', left: 11, display: 'flex', pointerEvents: 'none' }}>
            <SearchIcon color={searchFocused ? 'rgba(78,190,206,0.9)' : 'rgba(245,245,244,0.3)'} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search name, phone, email…"
            aria-label="Search contacts"
            style={{
              width: '100%', background: searchFocused ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.035)',
              border: '1px solid transparent',
              borderRadius: 999, padding: `7px ${query ? 28 : 10}px 7px 30px`, fontSize: 12.5, color: '#f5f5f4', outline: 'none',
              transition: 'background 0.15s ease',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              style={{
                position: 'absolute', right: 8, width: 18, height: 18, borderRadius: '50%', border: 'none',
                background: 'rgba(255,255,255,0.1)', color: 'rgba(245,245,244,0.6)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <XIcon size={9} />
            </button>
          )}
        </div>
      </div>

      {/* paddingBottom clears the floating global composer. */}
      <div style={{ flex: 1, position: 'relative', overflowY: 'auto', minHeight: 0, paddingBottom: 96 }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {[0, 0.08, 0.16, 0.24, 0.32].map((d, i) => <ContactRowSkeleton key={i} delay={d} />)}
          </div>
        )}
        {error && (
          <p style={{ fontSize: 13, color: '#fb7185' }}>{error}</p>
        )}
        {!loading && !error && contacts?.length === 0 && (
          <p style={{ fontSize: 13, color: LABEL_COLOR, lineHeight: 1.6, maxWidth: 360 }}>
            No contacts yet for this workspace. Contacts appear here automatically once guests
            message this business on WhatsApp, Instagram, Messenger, or email.
          </p>
        )}
        {!loading && !error && contacts && contacts.length > 0 && filtered.length === 0 && (
          <p style={{ fontSize: 13, color: LABEL_COLOR, lineHeight: 1.6 }}>
            {query ? `No contacts match "${query}".` : 'No flagged contacts.'}
          </p>
        )}
        {filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 640 }}>
            {filtered.map((c) => (
              <ContactRow key={c.id} contact={c} onClick={() => setSelected(c)} />
            ))}
          </div>
        )}
        {selected && <ContactDetail contact={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}
