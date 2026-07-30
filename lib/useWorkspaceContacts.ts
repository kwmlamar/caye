'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'
import type { Contact } from '@/types/database'

// Same fetch shape as useCommandOverview (lib/useCommandOverview.ts) —
// Bearer JWT against a founder-only API route, scoped to one workspace.
export function useWorkspaceContacts(workspaceId: string | null) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the most recent load may write, so a slow cold load can't land on
  // top of a newer background refresh (or a workspace switch).
  const requestIdRef = useRef(0)

  // `quiet` skips the loading flag and the error state: a background
  // refresh must not swap a panel the founder is reading for a spinner,
  // and a dropped one isn't worth surfacing — the next will land.
  const load = useCallback(async (quiet = false) => {
    if (!workspaceId) return
    const requestId = ++requestIdRef.current
    if (!quiet) { setLoading(true); setError(null) }

    const { session } = await getSession()
    if (requestId !== requestIdRef.current) return
    if (!session) {
      if (!quiet) { setError('Not signed in'); setLoading(false) }
      return
    }
    try {
      const res = await fetch(`/api/founder/contacts?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (requestId !== requestIdRef.current) return
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      setContacts(json.contacts)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      if (!quiet) setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      if (requestId === requestIdRef.current && !quiet) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(() => { load(true) }, [load])
  useFreshness(workspaceId, ['contacts'], refresh)
  useRevalidateOnFocus(refresh)

  return { contacts, loading, error }
}
