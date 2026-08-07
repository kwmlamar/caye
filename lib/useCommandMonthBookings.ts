'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import type { Booking } from '@/lib/useCommandOverview'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'

export interface CommandMonthBookings {
  bookings: Booking[]
  month_start: string
  month_offset: number
}

// Mirrors useCommandOverview's cache-by-key/revalidate-quietly shape, but
// against the lean /api/founder/bookings-month route — CommandCalendar's
// month view has its own offset axis (calendar months) independent of
// weekOffset, so it can't just widen useCommandOverview's cache key.
const monthCache = new Map<string, CommandMonthBookings>()

function cacheKey(workspaceId: string, monthOffset: number): string {
  return `${workspaceId}:${monthOffset}`
}

export function useCommandMonthBookings(workspaceId: string | null, monthOffset: number) {
  const [data, setData] = useState<CommandMonthBookings | null>(
    () => (workspaceId ? monthCache.get(cacheKey(workspaceId, monthOffset)) ?? null : null)
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    const { session } = await getSession()
    if (!session) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    try {
      const res = await fetch(`/api/founder/bookings-month?workspaceId=${workspaceId}&monthOffset=${monthOffset}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      monthCache.set(cacheKey(workspaceId, monthOffset), json)
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, monthOffset])

  useEffect(() => {
    load()
  }, [load])

  useFreshness(workspaceId, ['bookings', 'escalations'], load)
  useRevalidateOnFocus(load)

  return { data, loading, revalidating: loading && data !== null, error, refetch: load }
}
