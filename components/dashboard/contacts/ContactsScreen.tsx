'use client'

import { useState, useEffect } from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import { getContacts } from '@/lib/supabase'
import { useDashboard } from '@/lib/dashboard-context'
import { formatDistanceToNow } from '@/lib/utils'
import { toast } from 'sonner'
import type { Contact } from '@/types/database'
import type { ChannelType } from '@/lib/types'
import { useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import ContactDetailPanel from './ContactDetailPanel'

function toChannelType(ct: string | null): ChannelType {
  if (ct === 'whatsapp') return 'wa'
  if (ct === 'instagram') return 'ig'
  if (ct === 'messenger') return 'fb'
  return 'em'
}

const CH_LABEL: Record<ChannelType, string> = {
  wa: 'WhatsApp', ig: 'Instagram', fb: 'Messenger', em: 'Email',
}

export default function ContactsScreen({ inPanel = false }: { inPanel?: boolean }) {
  const { setPanelScreen, setPendingContactChannelId, isPanelDetail, setIsPanelDetail } = useDashboard()
  const { workspaceId } = useWorkspace()
  const searchParams = useSearchParams()
  const contactChannelId = searchParams.get('contactChannelId')

  const [contacts, setContacts] = useState<Contact[]>([])
  const [active, setActive] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (inPanel && !isPanelDetail) {
      setActive(null)
    }
  }, [isPanelDetail, inPanel])

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
            if (contactChannelId) {
              const matched = data.find(c => c.channel_id === contactChannelId)
              if (matched) return matched
            }
            if (prev && data.some(c => c.id === prev.id)) return prev
            // Auto-select first if not in panel
            return (!inPanel && data.length > 0) ? data[0] : null
          })
        }
        setLoading(false)
      }
    }
    load()
    return () => { ignore = true }
  }, [debouncedQ, contactChannelId, inPanel])

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
    setPanelScreen('chats')
  }

  if (inPanel) {
    return (
      <div className="contacts-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {active ? (
          <ContactDetailPanel
            contact={active}
            workspaceId={workspaceId}
            onMessageClick={handleMessage}
            onClose={() => {
              setActive(null)
              setIsPanelDetail(false)
            }}
            onContactUpdated={(updated) => {
              setContacts(p => p.map(c => c.id === updated.id ? updated : c))
              setActive(updated)
            }}
          />
        ) : (
          <aside className="contacts-list" style={{ borderRight: 'none', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="ct-head">
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

            <div className="ct-table" style={{ padding: '0 4px 16px' }}>
              <div className="ct-table-head" style={{ gridTemplateColumns: '1fr 60px 1fr' }}>
                <span>Name</span>
                <span>Ch</span>
                <span>Last seen</span>
              </div>

              {loading ? (
                [...Array(7)].map((_, i) => (
                  <div key={i} className="ct-row" style={{ opacity: 0.35, pointerEvents: 'none' }}>
                    <span className="ct-name">
                      <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--tc-ink-faint)', display: 'inline-block', flexShrink: 0 }} />
                      <div>
                        <div style={{ width: 80, height: 9, background: 'var(--tc-ink-faint)', borderRadius: 4 }} />
                      </div>
                    </span>
                  </div>
                ))
              ) : filtered.length === 0 ? (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  {q ? 'No contacts match' : 'No contacts yet'}
                </div>
              ) : (
                filtered.map(c => (
                  <button
                    key={c.id}
                    className="ct-row"
                    onClick={() => {
                      setActive(c)
                      setIsPanelDetail(true)
                    }}
                    style={{ gridTemplateColumns: '1fr 60px 1fr' }}
                  >
                    <span className="ct-name">
                      <Avatar name={c.name || c.phone_number || '?'} size={28} />
                      <div className="truncate text-left">
                        <div className="n truncate">{c.name || 'Unknown'}</div>
                      </div>
                    </span>
                    <span className="ct-ch">
                      <ChannelIcon ch={toChannelType(c.channel_type)} size={18} />
                    </span>
                    <span className="ct-ls text-right">
                      {c.last_message_at ? formatDistanceToNow(c.last_message_at) : '—'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    )
  }

  return (
    <div className="contacts-screen">
      <aside className="contacts-list">
        <div className="ct-head">
          {!inPanel && (
            <div className="inbox-title">
              <h2>Contacts</h2>
              <span className="count-pill">{contacts.length}</span>
            </div>
          )}
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

      {active ? (
        <ContactDetailPanel
          contact={active}
          workspaceId={workspaceId}
          onMessageClick={handleMessage}
          onContactUpdated={(updated) => {
            setContacts(p => p.map(c => c.id === updated.id ? updated : c))
            setActive(updated)
          }}
        />
      ) : (
        <aside className="contact-detail">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--tc-ink-faint)', fontSize: 13, padding: 48, textAlign: 'center' }}>
            Select a contact to view their profile.
          </div>
        </aside>
      )}
    </div>
  )
}
