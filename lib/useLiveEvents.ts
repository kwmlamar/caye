'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'

export type EventTone = 'positive' | 'neutral' | 'alert'

export interface LiveEvent {
  id: number
  at: string
  type: string
  label: string
  tone: EventTone
}

const POLL_MS = 20_000

/**
 * Shared poll against /api/founder/live-events — one real data source
 * (workspace_events) behind both the "Live" strip and "Caye's Log", just
 * at different `limit` depths. See that route's doc comment.
 */
export function useLiveEvents(workspaceId: string, limit = 8) {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const { session } = await getSession()
      if (!session || cancelled) return
      try {
        const res = await fetch(`/api/founder/live-events?workspaceId=${workspaceId}&limit=${limit}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok || cancelled) return
        const json = await res.json()
        setEvents(json.events ?? [])
      } catch {
        // Silent — a missed poll just leaves the last known events showing.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [workspaceId, limit])

  return { events, loading }
}
