'use client'

import { useState } from 'react'
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

function Avatar({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <div style={{
      width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(125,201,203,0.12)', border: '1px solid rgba(125,201,203,0.3)',
      color: '#7DC9CB', fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-display)',
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
  const facts = contact.ai_contact_facts
  const factLines: string[] = []
  if (facts?.dietary?.length) factLines.push(`Dietary: ${facts.dietary.join(', ')}`)
  if (facts?.mobility?.length) factLines.push(`Mobility: ${facts.mobility.join(', ')}`)
  if (facts?.group_composition) factLines.push(`Group: ${facts.group_composition}`)
  if (facts?.preferences?.length) factLines.push(`Preferences: ${facts.preferences.join(', ')}`)
  if (facts?.occasions?.length) factLines.push(`Occasions: ${facts.occasions.join(', ')}`)

  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(9,9,11,0.75)',
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 10,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, background: CARD_BG, boxShadow: '-24px 0 48px rgba(0,0,0,0.35)',
          padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar name={contact.name ?? contact.phone_number ?? contact.channel_id ?? '?'} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#f4f4f5' }}>
                {contact.name ?? contact.phone_number ?? contact.channel_id ?? 'Unknown'}
              </div>
              <div style={{ fontSize: 11, color: LABEL_COLOR }}>
                {CHANNEL_LABEL[contact.channel_type ?? ''] ?? contact.channel_type ?? '—'}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 26, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.09)',
              color: '#a1a1aa', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>

        {(contact.is_blocked || contact.opted_out) && (
          <div style={{ display: 'flex', gap: 6 }}>
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
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: '10px 14px', borderRadius: 12, cursor: 'pointer',
        border: `1px solid ${hover ? '#2d2d34' : 'transparent'}`,
        background: hover ? 'rgba(24,24,27,0.9)' : 'transparent',
      }}
    >
      <Avatar name={displayName} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: '#f4f4f5',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {displayName}
        </div>
        <div style={{ fontSize: 11, color: LABEL_COLOR }}>
          {CHANNEL_LABEL[contact.channel_type ?? ''] ?? contact.channel_type ?? '—'}
          {contact.last_message_at ? ` · ${formatDistanceToNow(contact.last_message_at)}` : ''}
          {` · ${contact.total_messages_received + contact.total_messages_sent} msgs`}
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

export default function ContactsPanel({ workspaceId }: { workspaceId: string }) {
  const { contacts, loading, error } = useWorkspaceContacts(workspaceId)
  const [selected, setSelected] = useState<Contact | null>(null)

  return (
    <div style={{ flex: 1, position: 'relative', overflowY: 'auto', padding: 20 }}>
      {loading && (
        <CayeLoadingPulse label="Loading contacts…" size={16} />
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
      {contacts && contacts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 640 }}>
          {contacts.map((c) => (
            <ContactRow key={c.id} contact={c} onClick={() => setSelected(c)} />
          ))}
        </div>
      )}
      {selected && <ContactDetail contact={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
