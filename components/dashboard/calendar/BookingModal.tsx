'use client'

import { useState, useEffect } from 'react'
import { getSupabase } from '@/lib/supabase'

export interface BookingModalData {
  id?: string
  service_id: string | null
  customer_name: string
  customer_phone: string
  customer_email: string
  booking_date: string  // 'YYYY-MM-DD'
  booking_time: string  // 'HH:MM'
  number_of_people: number
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled'
  notes: string
}

interface Service {
  id: string
  name: string
  duration_minutes: number
}

interface Props {
  workspaceId: string
  initial: BookingModalData
  mode: 'new' | 'edit'
  onClose: () => void
  onSaved: () => void
}

export default function BookingModal({ workspaceId, initial, mode, onClose, onSaved }: Props) {
  const [form, setForm] = useState<BookingModalData>(initial)
  const [services, setServices] = useState<Service[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load services for the dropdown
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getSupabase()
      const { data } = await supabase
        .from('booking_services')
        .select('id, name, duration_minutes')
        .eq('user_id', workspaceId)
        .eq('active', true)
        .order('name')
      if (!cancelled && data) setServices(data as Service[])
    })()
    return () => { cancelled = true }
  }, [workspaceId])

  function set<K extends keyof BookingModalData>(key: K, value: BookingModalData[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleSave() {
    if (!form.customer_name.trim()) {
      setError('Customer name is required')
      return
    }
    if (!form.booking_date || !form.booking_time) {
      setError('Date and time are required')
      return
    }
    setSaving(true)
    setError(null)

    const supabase = getSupabase()
    const payload = {
      user_id: workspaceId,
      service_id: form.service_id || null,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      customer_email: form.customer_email.trim() || null,
      booking_date: form.booking_date,
      booking_time: form.booking_time.length === 5 ? `${form.booking_time}:00` : form.booking_time,
      number_of_people: form.number_of_people,
      status: form.status,
      notes: form.notes.trim() || null,
    }

    const { error: dbErr } = mode === 'edit' && form.id
      ? await supabase.from('bookings').update(payload).eq('id', form.id)
      : await supabase.from('bookings').insert(payload)

    setSaving(false)
    if (dbErr) {
      setError(dbErr.message)
      return
    }
    onSaved()
  }

  async function handleCancel() {
    if (!form.id) return
    if (!confirm('Cancel this booking? The customer will not be notified automatically.')) return
    setSaving(true)
    const supabase = getSupabase()
    const { error: dbErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', form.id)
    setSaving(false)
    if (dbErr) {
      setError(dbErr.message)
      return
    }
    onSaved()
  }

  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <header className="bk-modal-head">
          <h3>{mode === 'edit' ? 'Edit booking' : 'New booking'}</h3>
          <button className="ico-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="bk-modal-body">
          <div className="bk-field">
            <label>Service</label>
            <select
              className="s-input"
              value={form.service_id ?? ''}
              onChange={e => set('service_id', e.target.value || null)}
            >
              <option value="">— None —</option>
              {services.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.duration_minutes} min)</option>
              ))}
            </select>
          </div>

          <div className="bk-field">
            <label>Customer name *</label>
            <input
              className="s-input"
              value={form.customer_name}
              onChange={e => set('customer_name', e.target.value)}
              placeholder="Jane Doe"
            />
          </div>

          <div className="bk-field-row">
            <div className="bk-field">
              <label>Phone</label>
              <input
                className="s-input"
                value={form.customer_phone}
                onChange={e => set('customer_phone', e.target.value)}
                placeholder="+1 (242) 555-0142"
              />
            </div>
            <div className="bk-field">
              <label>Email</label>
              <input
                className="s-input"
                type="email"
                value={form.customer_email}
                onChange={e => set('customer_email', e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
          </div>

          <div className="bk-field-row">
            <div className="bk-field">
              <label>Date *</label>
              <input
                className="s-input"
                type="date"
                value={form.booking_date}
                onChange={e => set('booking_date', e.target.value)}
              />
            </div>
            <div className="bk-field">
              <label>Time *</label>
              <input
                className="s-input"
                type="time"
                value={form.booking_time.slice(0, 5)}
                onChange={e => set('booking_time', e.target.value)}
              />
            </div>
            <div className="bk-field" style={{ maxWidth: 100 }}>
              <label>Guests</label>
              <input
                className="s-input"
                type="number"
                min={1}
                value={form.number_of_people}
                onChange={e => set('number_of_people', Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </div>

          <div className="bk-field">
            <label>Status</label>
            <select
              className="s-input"
              value={form.status}
              onChange={e => set('status', e.target.value as BookingModalData['status'])}
            >
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div className="bk-field">
            <label>Notes</label>
            <textarea
              className="s-textarea"
              rows={3}
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Anything Caye should know about this booking…"
            />
          </div>

          {error && <div className="bk-modal-error">{error}</div>}
        </div>

        <footer className="bk-modal-foot">
          {mode === 'edit' && form.status !== 'cancelled' && (
            <button className="ghost-btn danger" onClick={handleCancel} disabled={saving}>
              Cancel booking
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="ghost-btn" onClick={onClose} disabled={saving}>Close</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create booking'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
