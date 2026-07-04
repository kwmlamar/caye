'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import type { Contact } from '@/types/database'

// Same fetch shape as useCommandOverview (lib/useCommandOverview.ts) —
// Bearer JWT against a founder-only API route, scoped to one workspace.
export function useWorkspaceContacts(workspaceId: string | null) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      const { session } = await getSession()
      if (!session) {
        if (!cancelled) { setError('Not signed in'); setLoading(false) }
        return
      }
      try {
        const res = await fetch(`/api/founder/contacts?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Failed to load')
        if (!cancelled) setContacts(json.contacts)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [workspaceId])

  return { contacts, loading, error }
}
