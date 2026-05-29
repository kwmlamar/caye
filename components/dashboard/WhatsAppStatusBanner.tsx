'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

/**
 * Top-of-dashboard banner that appears when Caye can't reach the operator on
 * WhatsApp (3 consecutive failures) or got blocked by them. Silent otherwise.
 *
 * Operator can:
 *  - Open settings → re-verify their number.
 *  - "Retry" → clears the unreachable/blocked flag so the next ping attempts again.
 *  - Dismiss → hides until the flag flips back true.
 */
export default function WhatsAppStatusBanner() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [unreachable, setUnreachable] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function load() {
    if (!workspaceId) return
    const supabase = getSupabase()
    const { data } = await supabase
      .from('workspace_ai_config')
      .select('whatsapp_unreachable, whatsapp_blocked')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    setUnreachable(Boolean(data?.whatsapp_unreachable))
    setBlocked(Boolean(data?.whatsapp_blocked))
  }

  useEffect(() => {
    load()
    // Realtime: re-poll on workspace_ai_config row update.
    if (!workspaceId) return
    const supabase = getSupabase()
    const channel = supabase
      .channel(`wa-status-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'workspace_ai_config',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => load()
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  if (dismissed) return null
  if (!unreachable && !blocked) return null

  async function retry() {
    setBusy(true)
    try {
      const supabase = getSupabase()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      await fetch('/api/caye/whatsapp/config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(
          blocked ? { clearBlocked: true } : { clearUnreachable: true }
        ),
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const text = blocked
    ? 'Looks like the Caye number got blocked on your WhatsApp. If unintentional, unblock and click retry.'
    : "Caye couldn't reach you on WhatsApp for 3 pings. Update your number or check your device."

  return (
    <div
      style={{
        background: '#FFE2D3',
        color: '#5C2A0F',
        border: '1px solid #F4B68F',
        borderRadius: 12,
        padding: '10px 14px',
        margin: '0 0 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button
        onClick={() => router.push(`/dashboard/${workspaceId}/settings?tab=whatsapp`)}
        style={{
          background: 'transparent',
          border: '1px solid #5C2A0F',
          color: '#5C2A0F',
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {blocked ? 'Open settings' : 'Update number'}
      </button>
      <button
        onClick={retry}
        disabled={busy}
        style={{
          background: '#5C2A0F',
          border: 'none',
          color: '#FFE2D3',
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        Retry
      </button>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#5C2A0F',
          fontSize: 16,
          cursor: 'pointer',
          padding: '2px 6px',
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
