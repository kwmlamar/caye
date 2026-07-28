'use client'

import { useState, useEffect, useRef } from 'react'
import { getSession } from '@/lib/supabase'

const POLL_MS = 45_000
const LAST_SEEN_KEY = 'cayeWorkspaceLastSeen'

function loadLastSeen(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveLastSeen(map: Record<string, string>) {
  if (typeof window === 'undefined') return
  localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map))
}

/**
 * Per-workspace "something happened" signal for the founder's sidebar
 * (FounderHome). Polls /api/founder/workspaces-activity for a raw
 * last-activity timestamp per workspace, then compares it against a
 * "last viewed" watermark kept in localStorage — there's no per-viewer
 * read-state in the DB (see the route's doc comment), so the watermark
 * lives client-side instead of requiring a migration.
 *
 * markSeen(workspaceId) should be called whenever the founder opens that
 * workspace, so its dot clears immediately rather than waiting on the next
 * poll tick.
 */
export function useWorkspacesActivity(workspaceIds: string[], activeWorkspaceId: string | null) {
  const [activity, setActivity] = useState<Record<string, string>>({})
  const [lastSeen, setLastSeen] = useState<Record<string, string>>(() => loadLastSeen())
  const idsKey = workspaceIds.join(',')
  const markedActiveRef = useRef<string | null>(null)

  useEffect(() => {
    if (!idsKey) return
    let cancelled = false

    async function poll() {
      const { session } = await getSession()
      if (!session || cancelled) return
      try {
        const res = await fetch(`/api/founder/workspaces-activity?workspaceIds=${idsKey}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setActivity(json.activity ?? {})
      } catch {
        // Silent — a missed activity poll isn't worth surfacing an error for.
      }
    }

    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [idsKey])

  // Viewing a workspace counts as seeing whatever's happened there so far.
  useEffect(() => {
    if (!activeWorkspaceId || markedActiveRef.current === activeWorkspaceId) return
    markedActiveRef.current = activeWorkspaceId
    setLastSeen((prev) => {
      const next = { ...prev, [activeWorkspaceId]: new Date().toISOString() }
      saveLastSeen(next)
      return next
    })
  }, [activeWorkspaceId])

  const hasActivity = (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) return false
    const at = activity[workspaceId]
    if (!at) return false
    const seen = lastSeen[workspaceId]
    return !seen || at > seen
  }

  return { hasActivity }
}
