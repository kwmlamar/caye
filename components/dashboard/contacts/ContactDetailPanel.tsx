'use client'

import { useState, useEffect } from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import { updateContact, getSupabase } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { toast } from 'sonner'
import type { Contact } from '@/types/database'
import type { ChannelType } from '@/lib/types'
import BookingModal, { type BookingModalData } from '../calendar/BookingModal'

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

interface ContactDetailPanelProps {
  contact: Contact
  workspaceId: string
  onClose?: () => void
  hideMessageAction?: boolean
  onMessageClick?: () => void
  onContactUpdated?: (updated: Contact) => void
}

export default function ContactDetailPanel({
  contact,
  workspaceId,
  onClose,
  hideMessageAction = false,
  onMessageClick,
  onContactUpdated,
}: ContactDetailPanelProps) {
  const [activeContact, setActiveContact] = useState<Contact>(contact)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [bookingModalOpen, setBookingModalOpen] = useState(false)
  const [bookingInitialData, setBookingInitialData] = useState<BookingModalData | null>(null)

  // Keep internal contact in sync when prop changes
  useEffect(() => {
    setActiveContact(contact)
  }, [contact])

  // Fetch bookings when contact changes
  useEffect(() => {
    let ignore = false
    async function loadBookings() {
      if (!activeContact) return
      const supabase = getSupabase()
      const conditions: string[] = []
      if (activeContact.name) conditions.push(`customer_name.ilike.%${activeContact.name}%`)
      if (activeContact.phone_number) conditions.push(`notes.ilike.%${activeContact.phone_number}%`)
      let query = supabase
        .from('bookings')
        .select('id, booking_date, number_of_people, status, service:booking_services(name)')
        .eq('customer_id', activeContact.customer_id)
        .order('booking_date', { ascending: false })
        .limit(5)
      if (conditions.length > 0) query = query.or(conditions.join(','))
      const { data } = await query
      if (!ignore && data) setBookings(data as unknown as Booking[])
    }
    loadBookings()
    return () => { ignore = true }
  }, [activeContact?.id])

  const refreshBookings = async () => {
    if (!activeContact) return
    const supabase = getSupabase()
    const conditions: string[] = []
    if (activeContact.name) conditions.push(`customer_name.ilike.%${activeContact.name}%`)
    if (activeContact.phone_number) conditions.push(`notes.ilike.%${activeContact.phone_number}%`)
    let query = supabase
      .from('bookings')
      .select('id, booking_date, number_of_people, status, service:booking_services(name)')
      .eq('customer_id', activeContact.customer_id)
      .order('booking_date', { ascending: false })
      .limit(5)
    if (conditions.length > 0) query = query.or(conditions.join(','))
    const { data } = await query
    if (data) setBookings(data as unknown as Booking[])
  }

  return (
    <aside className="contact-detail" style={{ width: '100%', height: '100%' }}>
      <div className="cd-head">
        <Avatar name={activeContact.name || '?'} size={64} />
        <div className="cd-id">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <h3 style={{ wordBreak: 'break-word' }}>{activeContact.name || 'Unknown'}</h3>
            {onClose && (
              <button 
                onClick={onClose} 
                style={{ 
                  fontSize: 24, 
                  color: 'var(--tc-ink-mute)', 
                  cursor: 'pointer',
                  padding: '0 4px',
                  lineHeight: 1,
                  background: 'none',
                  border: 'none',
                  marginTop: -4
                }}
                title="Close"
              >
                ×
              </button>
            )}
          </div>
          <div className="cd-tags">
            {activeContact.tags?.map(t => (
              <span key={t} className={'tag ' + (t === 'VIP' ? 'vip' : t === 'Cruise' ? 'cruise' : '')}>
                {t}
              </span>
            ))}
            {activeContact.is_blocked && (
              <span className="tag" style={{ background: 'var(--tc-coral-soft)', color: 'var(--tc-coral)' }}>
                Blocked
              </span>
            )}
          </div>
        </div>
        <div className="cd-actions">
          {!hideMessageAction && (
            <button className="ghost-btn" onClick={onMessageClick}>Message</button>
          )}
          <button 
            className="ghost-btn" 
            onClick={() => {
              setBookingInitialData({
                service_id: null,
                customer_name: activeContact.name || '',
                customer_phone: activeContact.phone_number || '',
                customer_email: activeContact.email || '',
                booking_date: new Date().toISOString().slice(0, 10),
                booking_time: '10:00',
                number_of_people: 1,
                duration_minutes: null,
                status: 'confirmed',
                notes: '',
              })
              setBookingModalOpen(true)
            }}
          >
            + Booking
          </button>
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
            <ChannelIcon ch={toChannelType(activeContact.channel_type)} size={16} />
            {' '}{CH_LABEL[toChannelType(activeContact.channel_type)]}
          </div>
        </div>
        <div>
          <div className="k">First seen</div>
          <div className="v">
            {activeContact.first_message_at ? formatDistanceToNow(activeContact.first_message_at) + ' ago' : '—'}
          </div>
        </div>
      </div>

      <div className="cd-fields">
        <div className="cd-field">
          <div className="k">Phone</div>
          <div className="v">{activeContact.phone_number || '—'}</div>
        </div>
        <div className="cd-field">
          <div className="k">Email</div>
          <div className="v">{activeContact.email || '—'}</div>
        </div>
        <div className="cd-field">
          <div className="k">Last seen</div>
          <div className="v">
            {activeContact.last_message_at ? formatDistanceToNow(activeContact.last_message_at) + ' ago' : '—'}
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
          defaultValue={activeContact.notes || ''}
          key={activeContact.id}
          onBlur={async (e) => {
            const newNote = e.target.value
            if (newNote === (contact.notes || '')) return
            const { error } = await updateContact(activeContact.id, { notes: newNote })
            if (error) {
              toast.error('Failed to save note')
            } else {
              toast.success('Note saved')
              const updated = { ...activeContact, notes: newNote }
              setActiveContact(updated)
              if (onContactUpdated) onContactUpdated(updated)
            }
          }}
        />
      </div>

      {bookingModalOpen && bookingInitialData && (
        <BookingModal
          workspaceId={workspaceId}
          initial={bookingInitialData}
          mode="new"
          onClose={() => setBookingModalOpen(false)}
          onSaved={() => {
            setBookingModalOpen(false);
            refreshBookings();
          }}
        />
      )}
    </aside>
  )
}
