'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'

export interface Escalation {
  id: string
  conversation_id: string | null
  category: string | null
  route_to: string | null
  customer_facing_message: string | null
  internal_context: string | null
  created_at: string
  owner_responded_at: string | null
  // Already selected by /api/founder/command-overview, just not typed
  // through until AttentionCard needed to tell "open" from "resolved" and
  // "timed out" apart (owner_responded_at null alone isn't enough — an
  // expired escalation is also unanswered but no longer actionable).
  expired_at: string | null
}

export interface Booking {
  id: string
  customer_name: string
  booking_date: string
  booking_time: string
  status: string
  number_of_people: number
  payment_confirmed: boolean
  conversation_id: string | null
  service_name: string | null
  has_open_escalation: boolean
}

export interface CommandOverview {
  escalations: Escalation[]
  pending_escalation_count: number
  daily_cost: { day: string; cost_usd: number }[]
  total_cost_usd: number
  llm_call_count: number
  bookings: Booking[]
  week_start: string
  week_offset: number
  caye_active: boolean
  caye_muted_until: string | null
}

// Shared by CommandScreen (the panel tab) and FounderHome (the founder's
// landing view) so there's one fetch path against
// /api/founder/command-overview, not two copies drifting apart.
// weekOffset (0 = this week) lets CommandCalendar page through
// weeks — CommandScreen doesn't pass it and keeps its old "this week only"
// behavior.
// Last good response per workspace+week, kept at module scope so it
// outlives the component. Switching workspaces navigates to a new
// /dashboard/[workspaceId] route, which remounts FounderHome and resets
// this hook to `data: null` — which blanked the whole console (stat cards
// to "—", calendar and conversations to empty boxes) on every switch,
// even when returning to a workspace viewed seconds earlier.
//
// Seeding from the cache means a return trip paints the previous view
// immediately and revalidates underneath, so the switch reads as instant.
// Same instinct as workspacesRef in app/dashboard/[workspaceId]/layout.tsx,
// which already does this for the workspace record itself.
const overviewCache = new Map<string, CommandOverview>()

function cacheKey(workspaceId: string, weekOffset: number): string {
  return `${workspaceId}:${weekOffset}`
}

export function useCommandOverview(workspaceId: string | null, weekOffset = 0) {
  const [data, setData] = useState<CommandOverview | null>(
    () => (workspaceId ? overviewCache.get(cacheKey(workspaceId, weekOffset)) ?? null : null)
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
      const res = await fetch(`/api/founder/command-overview?workspaceId=${workspaceId}&weekOffset=${weekOffset}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      overviewCache.set(cacheKey(workspaceId, weekOffset), json)
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, weekOffset])

  useEffect(() => {
    load()
  }, [load])

  // This one response backs the stat cards, the calendar and the spend
  // chart, so it cares about every topic that isn't purely conversation
  // list state. Callers keep painting the previous data while it reloads
  // (see `revalidating` below), so a refetch here is visually quiet.
  useFreshness(workspaceId, ['bookings', 'escalations', 'cost'], load)
  useRevalidateOnFocus(load)

  // `loading` is true for both a cold load and a background revalidate;
  // callers that already have something on screen want to tell those
  // apart so they dim rather than blank.
  return { data, loading, revalidating: loading && data !== null, error, refetch: load }
}
