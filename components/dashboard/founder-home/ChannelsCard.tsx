'use client'

import { useState } from 'react'
import { getSession } from '@/lib/supabase'
import { useWorkspaceChannels, type ChannelAccount } from '@/lib/useWorkspaceChannels'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill, GhostButton } from '@/components/dashboard/founder-home/console-ui'

// Same dark-console tokens as the rest of FounderHome's rail — kept
// local per the established pattern (see ContactsPanel.tsx).
const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'

const CHANNEL_META: Record<string, { name: string; mark: string; markBg: string }> = {
  whatsapp: { name: 'WhatsApp', mark: 'W', markBg: '#22c55e' },
  instagram: { name: 'Instagram DMs', mark: 'IG', markBg: 'linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)' },
  messenger: { name: 'Messenger', mark: 'M', markBg: '#3b82f6' },
  email: { name: 'Zoho Mail', mark: '@', markBg: '#c8402c' },
  gmail: { name: 'Gmail', mark: 'G', markBg: '#ea4335' },
  sms: { name: 'SMS', mark: '#', markBg: '#6b7681' },
}
const CHANNEL_ORDER = ['whatsapp', 'instagram', 'messenger', 'email', 'gmail', 'sms']
// Channels with a simple redirect-based OAuth initiator this card can
// link straight to. WhatsApp goes through Meta Embedded Signup (its own
// JS SDK + popup flow) — already completed during onboarding, so it's
// shown status-only here rather than re-implementing that flow. SMS has
// no connect flow anywhere in the app yet.
const REDIRECT_CONNECT: Record<string, string> = {
  email: '/api/auth/zoho',
  gmail: '/api/auth/gmail',
  messenger: '/api/auth/meta?channel=messenger',
  instagram: '/api/auth/meta?channel=instagram',
}

function ChannelRow({
  type, account, workspaceId, onDisconnected,
}: {
  type: string
  account: ChannelAccount | null
  workspaceId: string
  onDisconnected: () => void
}) {
  const [busy, setBusy] = useState(false)
  const meta = CHANNEL_META[type]
  const connected = account?.is_active === true
  const needsReauth = account?.needs_reauth === true
  const handle = account ? (account.channel_username || account.channel_account_name || account.channel_account_id) : null
  const redirectHref = REDIRECT_CONNECT[type]

  async function handleDisconnect() {
    if (!account || busy) return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/channels', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workspaceId, accountId: account.id }),
      })
      if (res.ok) onDisconnected()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px' }}>
      <span style={{
        width: 26, height: 26, borderRadius: 8, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: meta.markBg, color: '#fff', fontSize: 11, fontWeight: 700,
      }}>
        {meta.mark}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5' }}>{meta.name}</div>
        <div style={{ fontSize: 11, color: LABEL_COLOR, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {handle ?? (redirectHref ? 'Not connected' : 'Managed via onboarding')}
        </div>
      </div>
      <Pill
        color={needsReauth ? '#FFD68F' : connected ? '#34d399' : '#52525b'}
        label={needsReauth ? 'Reconnect' : connected ? 'Connected' : 'Not connected'}
      />
      {redirectHref && (
        connected && !needsReauth ? (
          <GhostButton label="Disconnect" color="#fca5a5" onClick={handleDisconnect} disabled={busy} busy={busy} />
        ) : (
          <GhostButton
            label={needsReauth ? 'Reconnect' : 'Connect'}
            color="#7DC9CB"
            href={`${redirectHref}${redirectHref.includes('?') ? '&' : '?'}workspaceId=${workspaceId}&source=founder`}
          />
        )
      )}
    </div>
  )
}

// Founder-facing view onto the same connected_accounts rows a workspace
// owner sees on their own Settings → Channels page — surfaced here so
// the founder doesn't have to leave Caye Command (and can connect a
// channel like Zoho on a customer's behalf) while triaging that
// workspace. Connect buttons link straight to the existing OAuth
// initiators (/api/auth/zoho, /gmail, /meta) rather than duplicating
// that flow; those routes redirect back to the workspace's own settings
// page on completion, not here, so the status shown below catches up
// next time this card is viewed.
export default function ChannelsCard({ workspaceId }: { workspaceId: string }) {
  const { channels, loading, error, refetch } = useWorkspaceChannels(workspaceId)

  return (
    <div style={{ flexShrink: 0, background: CARD_BG, borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR }}>
          Channels
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: LABEL_COLOR, margin: '0 0 8px', lineHeight: 1.5 }}>
        Where this workspace's front desk listens — connect Zoho or Gmail here if the owner hasn't.
      </p>
      {loading ? (
        <div style={{ padding: '10px 4px' }}><CayeLoadingPulse size={14} /></div>
      ) : error ? (
        <p style={{ fontSize: 12, color: '#fb7185' }}>{error}</p>
      ) : (
        <div>
          {CHANNEL_ORDER.map((type) => (
            <ChannelRow
              key={type}
              type={type}
              account={channels?.[type] ?? null}
              workspaceId={workspaceId}
              onDisconnected={refetch}
            />
          ))}
        </div>
      )}
    </div>
  )
}
