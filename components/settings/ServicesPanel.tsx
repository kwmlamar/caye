'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import Toggle from '@/components/ui/Toggle'
import SIcon from './SIcon'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Service {
  id: string
  name: string
  description: string | null
  duration_minutes: number | null
  price: number | null
  currency: string
  is_active: boolean
  is_shared: boolean
  max_capacity: number | null
  color: string | null
  created_at: string
}

interface ServiceForm {
  name: string
  description: string
  duration_minutes: string
  price: string
  currency: string
  is_active: boolean
  is_shared: boolean
  max_capacity: string
  color: string
}

const EMPTY_FORM: ServiceForm = {
  name: '',
  description: '',
  duration_minutes: '',
  price: '',
  currency: 'USD',
  is_active: true,
  is_shared: false,
  max_capacity: '10',
  color: '',
}

const PRESET_COLORS = [
  '#6366f1', '#3b82f6', '#06b6d4', '#10b981',
  '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6',
]

// ── Icons ─────────────────────────────────────────────────────────────────────
const TrashIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6 5.5l1 10h6l1-10" />
  </svg>
)
const EditIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.5 4.5 15 6l-9 9H4.5v-1.5l9-9zM12 6l2 2" />
  </svg>
)
const PlusIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
    <path d="M10 4.5v11M4.5 10h11" />
  </svg>
)
const CloseIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
    <path d="M5 5l10 10M15 5 5 15" />
  </svg>
)
const PeopleIcon = () => (
  <svg width={12} height={12} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="7.5" r="2.5" /><path d="M3.5 16c.5-2.5 2.4-4 4.5-4s4 1.5 4.5 4" /><path d="M13 5a2.5 2.5 0 0 1 0 5M14 12c2 .2 3 1.6 3.5 4" />
  </svg>
)

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDuration(mins: number | null): string {
  if (!mins) return '—'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatPrice(price: number | null, currency: string): string {
  if (price == null) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 0,
  }).format(price)
}

function serviceToForm(s: Service): ServiceForm {
  return {
    name: s.name,
    description: s.description ?? '',
    duration_minutes: s.duration_minutes != null ? String(s.duration_minutes) : '',
    price: s.price != null ? String(s.price) : '',
    currency: s.currency || 'USD',
    is_active: s.is_active,
    is_shared: s.is_shared,
    max_capacity: s.max_capacity != null ? String(s.max_capacity) : '10',
    color: s.color ?? '',
  }
}

function formIsDirty(a: ServiceForm, b: ServiceForm): boolean {
  return (
    a.name.trim() !== b.name.trim() ||
    a.description !== b.description ||
    a.duration_minutes !== b.duration_minutes ||
    a.price !== b.price ||
    a.currency !== b.currency ||
    a.is_active !== b.is_active ||
    a.is_shared !== b.is_shared ||
    a.max_capacity !== b.max_capacity ||
    a.color !== b.color
  )
}

// ── ServiceFormPanel (create / edit) ─────────────────────────────────────────
function ServiceFormPanel({
  initial,
  onSave,
  onCancel,
  isSaving,
}: {
  initial: ServiceForm
  onSave: (f: ServiceForm) => void
  onCancel: () => void
  isSaving: boolean
}) {
  const [form, setForm] = useState<ServiceForm>(initial)
  const set = (k: keyof ServiceForm, v: string | boolean) =>
    setForm(prev => ({ ...prev, [k]: v }))

  return (
    <div className="svc-form-panel">
      {/* Name */}
      <div className="svc-form-row">
        <label className="svc-form-label">
          Service name <span className="svc-required">*</span>
        </label>
        <input
          className="svc-form-input"
          placeholder="e.g. Sunset Cruise, Cave Tubing…"
          value={form.name}
          onChange={e => set('name', e.target.value)}
        />
      </div>

      {/* Description */}
      <div className="svc-form-row">
        <label className="svc-form-label">Description</label>
        <textarea
          className="svc-form-input svc-form-textarea"
          placeholder="What's included, what to bring, meeting point…"
          rows={3}
          value={form.description}
          onChange={e => set('description', e.target.value)}
        />
      </div>

      {/* Duration + Price */}
      <div className="svc-form-row-split">
        <div className="svc-form-col">
          <label className="svc-form-label">Duration (minutes)</label>
          <input
            className="svc-form-input"
            type="number"
            min={1}
            placeholder="120"
            value={form.duration_minutes}
            onChange={e => set('duration_minutes', e.target.value)}
          />
        </div>
        <div className="svc-form-col">
          <label className="svc-form-label">Price per person</label>
          <div className="svc-price-row">
            <select
              className="svc-form-select svc-currency"
              value={form.currency}
              onChange={e => set('currency', e.target.value)}
            >
              {['USD', 'BZD', 'TTD', 'JMD', 'BBD', 'XCD', 'EUR', 'GBP'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              className="svc-form-input"
              type="number"
              min={0}
              step={0.01}
              placeholder="0.00"
              value={form.price}
              onChange={e => set('price', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Color picker */}
      <div className="svc-form-row">
        <label className="svc-form-label">Calendar color</label>
        <div className="svc-color-row">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              className={`svc-color-dot${form.color === c ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => set('color', form.color === c ? '' : c)}
              title={c}
            />
          ))}
          <input
            type="color"
            className="svc-color-custom"
            value={form.color || '#6366f1'}
            onChange={e => set('color', e.target.value)}
            title="Custom color"
          />
        </div>
      </div>

      {/* Shared toggle */}
      <div className="svc-form-row svc-toggle-row">
        <div className="svc-toggle-info">
          <div className="svc-form-label" style={{ margin: 0 }}>Group / shared booking</div>
          <div className="svc-toggle-sub">
            Multiple parties can book the same slot. Great for group tours.
          </div>
        </div>
        <Toggle on={form.is_shared} onChange={v => set('is_shared', v)} />
      </div>

      {/* Max capacity (only when shared) */}
      {form.is_shared && (
        <div className="svc-form-row svc-capacity-row">
          <label className="svc-form-label">Max guests per slot</label>
          <div className="svc-capacity-input-wrap">
            <input
              className="svc-form-input svc-capacity-input"
              type="number"
              min={1}
              placeholder="10"
              value={form.max_capacity}
              onChange={e => set('max_capacity', e.target.value)}
            />
            <span className="svc-capacity-hint">guests</span>
          </div>
        </div>
      )}

      {/* Active toggle */}
      <div className="svc-form-row svc-toggle-row">
        <div className="svc-toggle-info">
          <div className="svc-form-label" style={{ margin: 0 }}>Active</div>
          <div className="svc-toggle-sub">
            Inactive services won&apos;t appear in Caye&apos;s availability or booking options.
          </div>
        </div>
        <Toggle on={form.is_active} onChange={v => set('is_active', v)} />
      </div>

      {/* Actions */}
      <div className="svc-form-actions">
        <button
          className="svc-btn svc-btn-ghost"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </button>
        <button
          className="svc-btn svc-btn-primary"
          onClick={() => onSave(form)}
          disabled={isSaving || !form.name.trim() || !formIsDirty(form, initial)}
        >
          {isSaving ? 'Saving…' : 'Save service'}
        </button>
      </div>
    </div>
  )
}

// ── ServiceCard ───────────────────────────────────────────────────────────────
function ServiceCard({
  svc,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  svc: Service
  onEdit: (s: Service) => void
  onToggleActive: (s: Service) => void
  onDelete: (s: Service) => void
}) {
  const dot = svc.color || 'var(--tc-ink)'

  return (
    <div className={`svc-card${svc.is_active ? '' : ' svc-card-inactive'}`}>
      <div className="svc-card-left">
        <div className="svc-dot" style={{ background: dot }} />
        <div className="svc-card-body">
          <div className="svc-card-name">
            {svc.name}
            {!svc.is_active && (
              <span className="svc-inactive-pill">Inactive</span>
            )}
          </div>
          <div className="svc-card-meta">
            {svc.duration_minutes && (
              <span>{formatDuration(svc.duration_minutes)}</span>
            )}
            {svc.price != null && (
              <span>{formatPrice(svc.price, svc.currency)}</span>
            )}
            {svc.is_shared && (
              <span className="svc-shared-badge">
                <PeopleIcon />
                Shared · {svc.max_capacity ?? 10} max
              </span>
            )}
          </div>
          {svc.description && (
            <div className="svc-card-desc">{svc.description}</div>
          )}
        </div>
      </div>
      <div className="svc-card-actions">
        <Toggle on={svc.is_active} onChange={() => onToggleActive(svc)} />
        <button className="svc-icon-btn" title="Edit" onClick={() => onEdit(svc)}>
          <EditIcon />
        </button>
        <button
          className="svc-icon-btn svc-icon-btn-danger"
          title="Delete"
          onClick={() => onDelete(svc)}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  )
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function ServicesPanel() {
  const { workspaceId } = useWorkspace()
  const [services, setServices] = useState<Service[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list')
  const [editTarget, setEditTarget] = useState<Service | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<Service | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('booking_services')
        .select('id, name, description, duration_minutes, price, currency, is_active, is_shared, max_capacity, color, created_at')
        .eq('user_id', workspaceId)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      setServices((data ?? []) as Service[])
    } catch (err) {
      toast.error('Failed to load services')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  // ── Create ──────────────────────────────────────────────────────────────────
  async function handleCreate(form: ServiceForm) {
    if (!workspaceId) return
    setIsSaving(true)
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('booking_services')
        .insert({
          user_id: workspaceId,
          name: form.name.trim(),
          description: form.description.trim() || null,
          duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
          price: form.price !== '' ? Number(form.price) : null,
          currency: form.currency || 'USD',
          is_active: form.is_active,
          is_shared: form.is_shared,
          max_capacity: form.is_shared ? (form.max_capacity ? Number(form.max_capacity) : 10) : null,
          color: form.color || null,
        })
        .select()
        .single()
      if (error) throw new Error(error.message)
      setServices(prev => [...prev, data as Service])
      setMode('list')
      toast.success(`"${(data as Service).name}" created`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────────
  async function handleUpdate(form: ServiceForm) {
    if (!editTarget || !workspaceId) return
    setIsSaving(true)
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('booking_services')
        .update({
          name: form.name.trim(),
          description: form.description.trim() || null,
          duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
          price: form.price !== '' ? Number(form.price) : null,
          currency: form.currency || 'USD',
          is_active: form.is_active,
          is_shared: form.is_shared,
          max_capacity: form.is_shared ? (form.max_capacity ? Number(form.max_capacity) : 10) : null,
          color: form.color || null,
        })
        .eq('id', editTarget.id)
        .eq('user_id', workspaceId)
        .select()
        .single()
      if (error) throw new Error(error.message)
      setServices(prev => prev.map(s => s.id === (data as Service).id ? data as Service : s))
      setMode('list')
      setEditTarget(null)
      toast.success(`"${(data as Service).name}" updated`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Toggle active ───────────────────────────────────────────────────────────
  async function handleToggleActive(svc: Service) {
    if (!workspaceId) return
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase
        .from('booking_services')
        .update({ is_active: !svc.is_active })
        .eq('id', svc.id)
        .eq('user_id', workspaceId)
        .select()
        .single()
      if (error) throw new Error(error.message)
      setServices(prev => prev.map(s => s.id === (data as Service).id ? data as Service : s))
      toast.success((data as Service).is_active ? `"${svc.name}" activated` : `"${svc.name}" deactivated`)
    } catch {
      toast.error('Could not update service')
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  async function handleDelete(svc: Service) {
    if (!workspaceId) return
    try {
      const supabase = getSupabase()

      // Check if bookings reference this service
      const { count } = await supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('service_id', svc.id)
        .eq('user_id', workspaceId)

      if (count && count > 0) {
        // Soft-delete: deactivate
        const { data, error } = await supabase
          .from('booking_services')
          .update({ is_active: false })
          .eq('id', svc.id)
          .eq('user_id', workspaceId)
          .select()
          .single()
        if (error) throw new Error(error.message)
        setServices(prev => prev.map(s => s.id === (data as Service).id ? data as Service : s))
        toast.success(`"${svc.name}" deactivated (${count} booking${count !== 1 ? 's' : ''} reference it)`)
      } else {
        // Hard-delete
        const { error } = await supabase
          .from('booking_services')
          .delete()
          .eq('id', svc.id)
          .eq('user_id', workspaceId)
        if (error) throw new Error(error.message)
        setServices(prev => prev.filter(s => s.id !== svc.id))
        toast.success(`"${svc.name}" deleted`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleteConfirm(null)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="set-section">
        <div className="set-section-head">
          <div className="ssh-title">Services</div>
        </div>
        <div className="svc-loading">Loading services…</div>
      </div>
    )
  }

  const active = services.filter(s => s.is_active)
  const inactive = services.filter(s => !s.is_active)

  return (
    <div className="set-section">
      {/* Header */}
      <div
        className="set-section-head"
        style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}
      >
        <div>
          <div className="ssh-title">Services</div>
          <div className="ssh-sub">
            Tours, activities, and offerings Caye can check availability for and book.
          </div>
        </div>
        {mode === 'list' && (
          <button
            className="svc-btn svc-btn-primary"
            onClick={() => { setEditTarget(null); setMode('create') }}
          >
            <PlusIcon /> New service
          </button>
        )}
      </div>

      {/* Create form */}
      {mode === 'create' && (
        <div className="svc-form-wrap">
          <div className="svc-form-header">
            <span>New service</span>
            <button className="svc-icon-btn" onClick={() => setMode('list')}>
              <CloseIcon />
            </button>
          </div>
          <ServiceFormPanel
            initial={EMPTY_FORM}
            onSave={handleCreate}
            onCancel={() => setMode('list')}
            isSaving={isSaving}
          />
        </div>
      )}

      {/* Edit form */}
      {mode === 'edit' && editTarget && (
        <div className="svc-form-wrap">
          <div className="svc-form-header">
            <span>Edit &quot;{editTarget.name}&quot;</span>
            <button
              className="svc-icon-btn"
              onClick={() => { setMode('list'); setEditTarget(null) }}
            >
              <CloseIcon />
            </button>
          </div>
          <ServiceFormPanel
            initial={serviceToForm(editTarget)}
            onSave={handleUpdate}
            onCancel={() => { setMode('list'); setEditTarget(null) }}
            isSaving={isSaving}
          />
        </div>
      )}

      {/* Empty state */}
      {mode === 'list' && services.length === 0 && (
        <div className="svc-empty">
          <div className="svc-empty-icon"><SIcon name="svc" size={28} /></div>
          <div className="svc-empty-title">No services yet</div>
          <div className="svc-empty-sub">
            Add your first service — tours, activities, excursions — and Caye will check availability and book them automatically.
          </div>
          <button className="svc-btn svc-btn-primary" onClick={() => setMode('create')}>
            <PlusIcon /> Add first service
          </button>
        </div>
      )}

      {/* Active services */}
      {mode === 'list' && active.length > 0 && (
        <div className="svc-group">
          <div className="svc-group-label">{active.length} active</div>
          {active.map(svc => (
            <ServiceCard
              key={svc.id}
              svc={svc}
              onEdit={s => { setEditTarget(s); setMode('edit') }}
              onToggleActive={handleToggleActive}
              onDelete={s => setDeleteConfirm(s)}
            />
          ))}
        </div>
      )}

      {/* Inactive services */}
      {mode === 'list' && inactive.length > 0 && (
        <div className="svc-group svc-group-inactive">
          <div className="svc-group-label">Inactive</div>
          {inactive.map(svc => (
            <ServiceCard
              key={svc.id}
              svc={svc}
              onEdit={s => { setEditTarget(s); setMode('edit') }}
              onToggleActive={handleToggleActive}
              onDelete={s => setDeleteConfirm(s)}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="svc-confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="svc-confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="svc-confirm-title">Delete &quot;{deleteConfirm.name}&quot;?</div>
            <div className="svc-confirm-body">
              If this service has existing bookings, it will be deactivated instead of deleted. This cannot be undone.
            </div>
            <div className="svc-confirm-actions">
              <button
                className="svc-btn svc-btn-ghost"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="svc-btn svc-btn-danger"
                onClick={() => handleDelete(deleteConfirm)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
