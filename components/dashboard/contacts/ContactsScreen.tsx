'use client'

import { useState, useEffect } from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import CayeMark from '@/components/ui/CayeMark'
import { getContacts, updateContact, getSupabase } from '@/lib/supabase'
import { useDashboard } from '@/lib/dashboard-context'
import { formatDistanceToNow } from '@/lib/utils'
import { toast } from 'sonner'
import type { Contact } from '@/types/database'
import type { ChannelType } from '@/lib/types'

function toChannelType(ct: string | null): ChannelType {
  if (ct === 'whatsapp') return 'wa'
  if (ct === 'instagram') return 'ig'
  if (ct === 'messenger') return 'fb'
  return 'em'
}

const CH_LABEL: Record<ChannelType, string> = {
  wa: 'WhatsApp', ig: 'Instagram', fb: 'Messenger', em: 'Email',
}

interface Booking {
  id: string
  booking_date: string
  number_of_people: number
  status: string
  service?: { name: string } | null
}

export default function ContactsScreen() {
  const { setScreen, setPendingContactChannelId } = useDashboard()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [active, setActive] = useState<Contact | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    let ignore = false
    async function load() {
      setLoading(true)
      const { data, error } = await getContacts(debouncedQ || undefined)
      if (!ignore) {
        if (error) toast.error('Failed to load contacts')
        else {
          setContacts(data)
          setActive(prev => {
            if (prev && data.some(c => c.id === prev.id)) return prev
            return data.length > 0 ? data[0] : null
          })
        }
        setLoading(false)
      }
    }
    load()
    return () => { ignore = true }
  }, [debouncedQ])

  useEffect(() => {
    if (!active) { setBookings([]); return }
    let ignore = false
    async function loadBookings() {
      const supabase = getSupabase()
      const conditions: string[] = []
      if (active!.name) conditions.push(`customer_name.ilike.%${active!.name}%`)
      if (active!.phone_number) conditions.push(`notes.ilike.%${active!.phone_number}%`)
      let query = supabase
        .from('bookings')
        .select('id, booking_date, number_of_people, status, service:booking_services(name)')
        .eq('customer_id', active!.customer_id)
        .order('booking_date', { ascending: false })
        .limit(5)
      if (conditions.length > 0) query = query.or(conditions.join(','))
      const { data } = await query
      if (!ignore && data) setBookings(data as unknown as Booking[])
    }
    loadBookings()
    return () => { ignore = true }
  }, [active?.id])

  // Derive top 3 tags from loaded contacts for filter tabs
  const tagCounts = contacts.reduce<Record<string, number>>((acc, c) => {
    c.tags?.forEach(t => { acc[t] = (acc[t] || 0) + 1 })
    return acc
  }, {})
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => tag)

  const filtered = tagFilter
    ? contacts.filter(c => c.tags?.includes(tagFilter))
    : contacts

  const handleMessage = () => {
    if (active?.channel_id) setPendingContactChannelId(active.channel_id)
    setScreen('chats')
  }

  return (
    <div className="contacts-screen">
      <aside className="contacts-list">
        <div className="ct-head">
          <div className="inbox-title">
            <h2>Contacts</h2>
            <span className="count-pill">{contacts.length}</span>
          </div>
          <div className="search">
            <span className="ico">⌕</span>
            <input
              placeholder="Find by name, phone, email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="seg">
            <button className={tagFilter === null ? 'on' : ''} onClick={() => setTagFilter(null)}>
              All
            </button>
            {topTags.map(tag => (
              <button
                key={tag}
                className={tagFilter === tag ? 'on' : ''}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                {tag} <span className="seg-count">{tagCounts[tag]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ct-table">
          <div className="ct-table-head">
            <span>Name</span>
            <span>Channel</span>
            <span>Messages</span>
            <span>Last seen</span>
          </div>

          {loading ? (
            [...Array(7)].map((_, i) => (
              <div key={i} className="ct-row" style={{ opacity: 0.35, pointerEvents: 'none' }}>
                <span className="ct-name">
                  <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--tc-ink-faint)', display: 'inline-block', flexShrink: 0 }} />
                  <div>
                    <div style={{ width: 100, height: 9, background: 'var(--tc-ink-faint)', borderRadius: 4 }} />
                  </div>
                </span>
              </div>
            ))
          ) : filtered.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
              {q ? 'No contacts match that search' : 'Contacts appear when customers message you'}
            </div>
          ) : (
            filtered.map(c => (
              <button
                key={c.id}
                className={'ct-row' + (c.id === active?.id ? ' active' : '')}
                onClick={() => setActive(c)}
              >
                <span className="ct-name">
                  <Avatar name={c.name || c.phone_number || '?'} size={28} />
                  <div>
                    <div className="n">{c.name || 'Unknown'}</div>
                    <div className="o">{c.email || c.phone_number || CH_LABEL[toChannelType(c.channel_type)]}</div>
                  </div>
                </span>
                <span className="ct-ch">
                  <ChannelIcon ch={toChannelType(c.channel_type)} size={18} />
                </span>
                <span className="ct-bk">
                  {(c.total_messages_sent + c.total_messages_received) === 0
                    ? <span className="muted">—</span>
                    : c.total_messages_sent + c.total_messages_received}
                </span>
                <span className="ct-ls">
                  {c.last_message_at ? formatDistanceToNow(c.last_message_at) : '—'}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <aside className="contact-detail">
        {active ? (
          <>
            <div className="cd-head">
              <Avatar name={active.name || '?'} size={64} />
              <div className="cd-id">
                <h3>{active.name || 'Unknown'}</h3>
                <div className="cd-tags">
                  {active.tags?.map(t => (
                    <span key={t} className={'tag ' + (t === 'VIP' ? 'vip' : t === 'Cruise' ? 'cruise' : '')}>
                      {t}
                    </span>
                  ))}
                  {active.is_blocked && (
                    <span className="tag" style={{ background: 'var(--tc-coral-soft)', color: 'var(--tc-coral)' }}>
                      Blocked
                    </span>
                  )}
                </div>
              </div>
              <div className="cd-actions">
                <button className="ghost-btn" onClick={handleMessage}>Message</button>
                <button className="ghost-btn">+ Booking</button>
              </div>
            </div>

            <div className="cd-stats">
              <div>
                <div className="k">Lifetime bookings</div>
                <div className="v">{bookings.length}</div>
              </div>
              <div>
                <div className="k">Channel</div>
                <div className="v inline">
                  <ChannelIcon ch={toChannelType(active.channel_type)} size={16} />
                  {' '}{CH_LABEL[toChannelType(active.channel_type)]}
                </div>
              </div>
              <div>
                <div className="k">First seen</div>
                <div className="v">
                  {active.first_message_at ? formatDistanceToNow(active.first_message_at) + ' ago' : '—'}
                </div>
              </div>
            </div>

            <div className="cd-fields">
              <div className="cd-field">
                <div className="k">Phone</div>
                <div className="v">{active.phone_number || '—'}</div>
              </div>
              <div className="cd-field">
                <div className="k">Email</div>
                <div className="v">{active.email || '—'}</div>
              </div>
              <div className="cd-field">
                <div className="k">Last seen</div>
                <div className="v">
                  {active.last_message_at ? formatDistanceToNow(active.last_message_at) + ' ago' : '—'}
                </div>
              </div>
            </div>

            <div className="cd-section">
              <div className="cd-section-head">
                <h4>Booking history</h4>
                <span className="muted">{bookings.length}</span>
              </div>
              {bookings.length === 0 ? (
                <div className="cd-empty">No bookings found.</div>
              ) : (
                <ul className="bk-list">
                  {bookings.map(b => (
                    <li key={b.id}>
                      <div className="bk-date">
                        {new Date(b.booking_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </div>
                      <div className="bk-body">
                        <div className="bk-tour">{b.service?.name || 'Tour'}</div>
                        <div className="bk-meta">
                          {b.number_of_people} guests ·{' '}
                          {b.status === 'confirmed' ? (
                            <span className="st-confirmed">Confirmed</span>
                          ) : b.status === 'pending' ? (
                            <span className="st-pending">Pending</span>
                          ) : (
                            <span className="st-done">Completed</span>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="cd-section">
              <div className="cd-section-head">
                <h4>Notes</h4>
              </div>
              <textarea
                className="cd-notes"
                placeholder="Anything Caye and your team should remember about this guest…"
                defaultValue={active.notes || ''}
                key={active.id}
                onBlur={async (e) => {
                  const newNote = e.target.value
                  if (newNote === (active.notes || '')) return
                  const { error } = await updateContact(active.id, { notes: newNote })
                  if (error) {
                    toast.error('Failed to save note')
                  } else {
                    toast.success('Note saved')
                    setContacts(p => p.map(c => c.id === active.id ? { ...c, notes: newNote } : c))
                    setActive(p => p ? { ...p, notes: newNote } : null)
                  }
                }}
              />
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--tc-ink-faint)', fontSize: 13, padding: 48, textAlign: 'center' }}>
            Select a contact to view their profile.
          </div>
        )}
      </aside>
    </div>
  )
}
