'use client'

import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import SIcon from './SIcon'
import SaveBar from './SaveBar'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface ProfileForm {
  business_name: string
  contact_email: string
  contact_phone: string
  timezone: string
  booking_url: string
  website_url: string
  /** Operator's actual human name. Distinct from business_name. Loaded into the
   *  back-office system prompt so Caye answers "who am I?" correctly. */
  full_name: string
  /** Operator's personal email — distinct from business contact_email. */
  operator_personal_email: string
  /** Operator's personal phone — distinct from business contact_phone. */
  operator_personal_phone: string
  /** Free-form context about the team and how the operator works. Loaded
   *  verbatim into the back-office prompt. */
  team_notes: string
}

/**
 * Light URL validation. Empty is OK (field is optional). Anything else
 * must parse cleanly with the URL constructor AND use http(s). We don't
 * try to fetch the URL — we just want to catch typos like "biminitours.com"
 * (no scheme) or "htttps://" before they end up in a Caye reply.
 */
function validateUrl(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'Must start with http:// or https://'
    }
    return null
  } catch {
    return 'Not a valid URL (include https://)'
  }
}

const TIMEZONES: { value: string; label: string }[] = [
  { value: 'America/Belize',        label: 'America/Belize (GMT-6)' },
  { value: 'America/Jamaica',       label: 'America/Jamaica (GMT-5)' },
  { value: 'America/Nassau',        label: 'America/Nassau (GMT-5)' },
  { value: 'America/Barbados',      label: 'America/Barbados (GMT-4)' },
  { value: 'America/Santo_Domingo', label: 'America/Santo_Domingo (GMT-4)' },
  { value: 'America/New_York',      label: 'America/New_York (GMT-5)' },
  { value: 'America/Chicago',       label: 'America/Chicago (GMT-6)' },
  { value: 'America/Denver',        label: 'America/Denver (GMT-7)' },
  { value: 'America/Los_Angeles',   label: 'America/Los_Angeles (GMT-8)' },
]

export default function ProfilePanel() {
  const { workspace, workspaceId } = useWorkspace()

  const [form, setForm] = useState<ProfileForm>({
    business_name: '',
    contact_email: '',
    contact_phone: '',
    timezone: 'America/Nassau',
    booking_url: '',
    website_url: '',
    full_name: '',
    operator_personal_email: '',
    operator_personal_phone: '',
    team_notes: '',
  })
  const [orig, setOrig] = useState<ProfileForm>(form)
  const [isSaving, setIsSaving] = useState(false)
  const [logoUrl, setLogoUrl] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Best-effort fetch for the operator-personal columns added 2026-06-22.
  // workspace context may not yet expose them — query directly. Falls back
  // to empty strings pre-migration.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getSupabase()
      const { data } = await supabase
        .from('customers')
        .select('operator_personal_email, operator_personal_phone, team_notes')
        .eq('id', workspaceId)
        .maybeSingle()
      if (cancelled || !data) return
      setForm((f) => ({
        ...f,
        operator_personal_email: (data.operator_personal_email as string | null) ?? '',
        operator_personal_phone: (data.operator_personal_phone as string | null) ?? '',
        team_notes: (data.team_notes as string | null) ?? '',
      }))
      setOrig((o) => ({
        ...o,
        operator_personal_email: (data.operator_personal_email as string | null) ?? '',
        operator_personal_phone: (data.operator_personal_phone as string | null) ?? '',
        team_notes: (data.team_notes as string | null) ?? '',
      }))
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    const w = workspace as typeof workspace & { contact_phone?: string; full_name?: string }
    const rawTz = workspace.timezone || 'America/Nassau'
    const initial: ProfileForm = {
      business_name: workspace.business_name || '',
      contact_email: workspace.contact_email || '',
      contact_phone: w.contact_phone || '',
      timezone: rawTz,
      booking_url: workspace.booking_url || '',
      website_url: workspace.website_url || '',
      full_name: w.full_name || '',
      // These three load asynchronously above — leave blank here, the
      // effect above will fill them once the query resolves.
      operator_personal_email: '',
      operator_personal_phone: '',
      team_notes: '',
    }
    setForm((f) => ({
      ...initial,
      // Preserve the async-loaded values if they've already arrived.
      operator_personal_email: f.operator_personal_email || initial.operator_personal_email,
      operator_personal_phone: f.operator_personal_phone || initial.operator_personal_phone,
      team_notes: f.team_notes || initial.team_notes,
    }))
    setOrig((o) => ({
      ...initial,
      operator_personal_email: o.operator_personal_email || initial.operator_personal_email,
      operator_personal_phone: o.operator_personal_phone || initial.operator_personal_phone,
      team_notes: o.team_notes || initial.team_notes,
    }))
    setLogoUrl(workspace.avatar_url || '')
  }, [workspace])

  const bookingUrlError = validateUrl(form.booking_url)
  const websiteUrlError = validateUrl(form.website_url)
  const hasErrors = bookingUrlError !== null || websiteUrlError !== null

  const isDirty =
    form.business_name !== orig.business_name ||
    form.contact_email !== orig.contact_email ||
    form.contact_phone !== orig.contact_phone ||
    form.timezone !== orig.timezone ||
    form.booking_url !== orig.booking_url ||
    form.website_url !== orig.website_url ||
    form.full_name !== orig.full_name ||
    form.operator_personal_email !== orig.operator_personal_email ||
    form.operator_personal_phone !== orig.operator_personal_phone ||
    form.team_notes !== orig.team_notes

  const set =
    (k: keyof ProfileForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const handleDiscard = () => setForm(orig)

  const handleSave = async () => {
    if (hasErrors) {
      toast.error('Fix URL errors before saving')
      return
    }
    setIsSaving(true)
    try {
      const supabase = getSupabase()
      // Operator-personal columns are best-effort — if the migration
      // hasn't been applied in this environment yet, drop them from the
      // update and retry rather than failing the whole save.
      const baseUpdate = {
        business_name: form.business_name,
        contact_email: form.contact_email,
        contact_phone: form.contact_phone,
        timezone: form.timezone,
        booking_url: form.booking_url.trim() || null,
        website_url: form.website_url.trim() || null,
        full_name: form.full_name.trim() || null,
        updated_at: new Date().toISOString(),
      }
      const operatorUpdate = {
        operator_personal_email: form.operator_personal_email.trim() || null,
        operator_personal_phone: form.operator_personal_phone.trim() || null,
        team_notes: form.team_notes.trim() || null,
      }

      let { error } = await supabase
        .from('customers')
        .update({ ...baseUpdate, ...operatorUpdate })
        .eq('id', workspaceId)

      if (error && /column.*(operator_personal|team_notes).*does not exist/i.test(error.message)) {
        // Pre-migration environment — save the base fields only.
        const retry = await supabase
          .from('customers')
          .update(baseUpdate)
          .eq('id', workspaceId)
        error = retry.error
        if (!error) toast.warning('Saved (operator-personal fields not yet migrated)')
      }

      if (error) throw new Error(error.message)
      setOrig(form)
      toast.success('Profile saved')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsUploading(true)
    try {
      const supabase = getSupabase()
      const ext = file.name.split('.').pop()
      const path = `${workspaceId}/logo.${ext}`
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true })
      if (upErr) throw new Error(upErr.message)

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
      await supabase.from('customers').update({ avatar_url: publicUrl }).eq('id', workspaceId)
      setLogoUrl(publicUrl)
      toast.success('Logo uploaded')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const handleLogoRemove = async () => {
    try {
      const supabase = getSupabase()
      await supabase.from('customers').update({ avatar_url: null }).eq('id', workspaceId)
      setLogoUrl('')
      toast.success('Logo removed')
    } catch {
      toast.error('Failed to remove logo')
    }
  }

  const initials = (form.business_name || 'K').charAt(0).toUpperCase()

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Profile</div>
          <h1>Business identity</h1>
          <p className="set-page-desc">
            How your tour business appears to guests across every channel — booking pages, automated replies, and receipts.
          </p>
        </div>
        <div className="ph-right">
          <button className="btn-ghost"><SIcon name="external" size={14} /> View public page</button>
        </div>
      </header>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Identity</h3>
            <div className="desc">Shown to guests in chat headers, confirmation emails and your booking page.</div>
          </div>
        </div>
        <div className="s-card-body">
          <div className="s-row">
            <div className="s-label">
              Business logo
              <span className="help">PNG or SVG, square, min 512px.</span>
            </div>
            <div className="s-field">
              <div className="logo-upload">
                <div className="logo-preview" style={logoUrl ? { padding: 0, overflow: 'hidden' } : {}}>
                  {logoUrl ? (
                    <img src={logoUrl} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    initials
                  )}
                </div>
                <div className="logo-actions">
                  <div className="logo-buttons">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleLogoUpload}
                      accept="image/*"
                      style={{ display: 'none' }}
                    />
                    <button
                      className="btn-solid sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                    >
                      <SIcon name="upload" size={13} />
                      {isUploading ? 'Uploading…' : 'Upload new'}
                    </button>
                    {logoUrl && (
                      <button className="btn-ghost sm danger" onClick={handleLogoRemove}>Remove</button>
                    )}
                  </div>
                  <div className="logo-hint">
                    {logoUrl ? 'Logo uploaded' : 'no file chosen'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Business name</div>
            <div className="s-field">
              <input className="s-input" value={form.business_name} onChange={set('business_name')} />
              <div className="s-help">Displayed as the sender name on all outbound messages.</div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">
              Contact email
              <span className="help">Replies and guest receipts come from here.</span>
            </div>
            <div className="s-field">
              <input className="s-input" type="email" value={form.contact_email} onChange={set('contact_email')} />
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Phone</div>
            <div className="s-field">
              <input
                className="s-input"
                type="tel"
                value={form.contact_phone}
                onChange={set('contact_phone')}
                placeholder="+1 555 000 0000"
              />
              <div className="s-help">Used for SMS and WhatsApp Business setup.</div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Timezone</div>
            <div className="s-field">
              <select className="s-input" value={form.timezone} onChange={set('timezone')}>
                {/* Render current timezone even if it's not in the preset list */}
                {!TIMEZONES.find(t => t.value === form.timezone) && form.timezone && (
                  <option value={form.timezone}>{form.timezone}</option>
                )}
                {TIMEZONES.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
              <div className="s-help">Used for response delays, the daily summary, and tour scheduling.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>About you (the operator)</h3>
            <div className="desc">
              Who Caye is working for. She uses this to answer questions like &ldquo;who am I?&rdquo;
              and &ldquo;what&rsquo;s my email?&rdquo; when you message her on WhatsApp — and to know
              the difference between you and your business.
            </div>
          </div>
        </div>
        <div className="s-card-body">
          <div className="s-row">
            <div className="s-label">
              Your name
              <span className="help">Your actual name, not the business name.</span>
            </div>
            <div className="s-field">
              <input
                className="s-input"
                value={form.full_name}
                onChange={set('full_name')}
                placeholder="e.g. Karenda Swain-Rolle"
              />
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Your personal email</div>
            <div className="s-field">
              <input
                className="s-input"
                type="email"
                value={form.operator_personal_email}
                onChange={set('operator_personal_email')}
                placeholder="you@gmail.com"
              />
              <div className="s-help">
                Different from the business email above. Optional — only fill in if you want
                Caye to know where to reach you personally.
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Your personal phone</div>
            <div className="s-field">
              <input
                className="s-input"
                type="tel"
                value={form.operator_personal_phone}
                onChange={set('operator_personal_phone')}
                placeholder="+1 555 000 0000"
              />
              <div className="s-help">
                Different from the business phone above. Optional.
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">
              Team & context notes
              <span className="help">Free text — Caye reads this verbatim.</span>
            </div>
            <div className="s-field">
              <textarea
                className="s-input"
                rows={4}
                value={form.team_notes}
                onChange={set('team_notes')}
                placeholder={'e.g. "Max is my husband, helps on the boat. I work a day job at Foundation Resilience so I can\'t always reply during the day."'}
              />
              <div className="s-help">
                Anything you&rsquo;d want a new assistant to know on their first day —
                who&rsquo;s on the team, when you&rsquo;re unreachable, the quirks of how you operate.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Booking & website</h3>
            <div className="desc">
              Caye drops these into replies when a guest asks where to book or learn more —
              naturally, not as a footer on every message.
            </div>
          </div>
        </div>
        <div className="s-card-body">
          <div className="s-row">
            <div className="s-label">Booking link</div>
            <div className="s-field">
              <input
                className="s-input"
                type="url"
                value={form.booking_url}
                onChange={set('booking_url')}
                placeholder="https://yourbusiness.com/book"
              />
              <div className="s-help">
                {bookingUrlError
                  ? <span style={{ color: '#e85a3c' }}>{bookingUrlError}</span>
                  : 'Where guests can book themselves online — Squarespace, Acuity, Calendly, your own site, etc.'}
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Website</div>
            <div className="s-field">
              <input
                className="s-input"
                type="url"
                value={form.website_url}
                onChange={set('website_url')}
                placeholder="https://yourbusiness.com"
              />
              <div className="s-help">
                {websiteUrlError
                  ? <span style={{ color: '#e85a3c' }}>{websiteUrlError}</span>
                  : 'Your main site — where guests learn about your business.'}
              </div>
            </div>
          </div>
        </div>
      </section>

      <SaveBar isDirty={isDirty} isSaving={isSaving} onSave={handleSave} onDiscard={handleDiscard} />
    </div>
  )
}
