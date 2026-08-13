'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'

export interface TodayStats {
  customersAnswered: number
  customersWroteIn: number
  bookingsToday: number
  escalationsResolvedToday: number
}

const POLL_MS = 60_000

export function useTodayStats(workspaceId: string) {
  const [stats, setStats] = useState<TodayStats | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const { session } = await getSession()
      if (!session || cancelled) return
      try {
        const res = await fetch(`/api/founder/today-stats?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok || cancelled) return
        setStats(await res.json())
      } catch {
        // Silent — briefing just falls back to week-scoped numbers.
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [workspaceId])

  return stats
}
