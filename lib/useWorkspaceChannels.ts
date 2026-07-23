'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'

export interface ChannelAccount {
  id: string
  channel_type: string
  channel_account_name: string | null
  channel_username: string | null
  channel_account_id: string | null
  is_active: boolean
  needs_reauth: boolean | null
  created_at: string
}

// Same fetch shape as useWorkspaceContacts — Bearer JWT against a
// founder-only API route, scoped to one workspace. Exposes refetch so
// the Channels card can re-poll right after a redirect back from an
// OAuth connect flow.
export function useWorkspaceChannels(workspaceId: string | null) {
  const [channels, setChannels] = useState<Record<string, ChannelAccount> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    const { session } = await getSession()
    if (!session) { setError('Not signed in'); setLoading(false); return }
    try {
      const res = await fetch(`/api/founder/channels?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      setChannels(json.channels)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  return { channels, loading, error, refetch: load }
}
