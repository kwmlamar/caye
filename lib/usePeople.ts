'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'
import type { PersonSummary, PersonDetail } from '@/lib/people'

// Same fetch shape as useWorkspaceContacts/useFounderConversations — Bearer
// JWT against a founder-only route, scoped to one workspace. Listens to
// 'contacts' and 'conversations' (covers both contacts-side and
// outreach_leads-side conversation changes) and 'bookings' (customer
// booking-count changes); nothing currently emits a dedicated topic for
// outreach_leads status changes (those are cron-driven, not a founder
// action in an open session) — useRevalidateOnFocus is the catch-all for
// that, matching every other founder data hook in this app.
export function usePeople(workspaceId: string | null) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null)
  const [workspaceKind, setWorkspaceKind] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!workspaceId) return
    if (!quiet) { setLoading(true); setError(null) }
    const { session } = await getSession()
    if (!session) {
      if (!quiet) { setError('Not signed in'); setLoading(false) }
      return
    }
    try {
      const res = await fetch(`/api/founder/people?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      setPeople(json.people)
      setWorkspaceKind(json.workspaceKind ?? null)
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(() => { load(true) }, [load])
  useFreshness(workspaceId, ['contacts', 'conversations', 'bookings'], refresh)
  useRevalidateOnFocus(refresh)

  return { people, workspaceKind, loading, error }
}

export function usePersonDetail(workspaceId: string | null, personId: string | null) {
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !personId) { setPerson(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPerson(null)
    ;(async () => {
      const { session } = await getSession()
      if (!session || cancelled) return
      try {
        const res = await fetch(`/api/founder/people?workspaceId=${workspaceId}&id=${personId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || 'Failed to load')
        setPerson(json.person)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceId, personId])

  return { person, loading, error }
}
