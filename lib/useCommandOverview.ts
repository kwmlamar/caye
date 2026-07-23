'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'

export interface Escalation {
  id: string
  conversation_id: string | null
  category: string | null
  route_to: string | null
  customer_facing_message: string | null
  internal_context: string | null
  created_at: string
  owner_responded_at: string | null
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

export interface ConversationSummary {
  id: string
  channel_type: string
  customer_name: string | null
  last_message_preview: string | null
  last_message_at: string
  human_agent_enabled: boolean
  human_agent_reason: string | null
  /** hold_kind==='outreach_followup' + proposed_reply is what lets the
   *  compose box auto-fill — scoped to this one narrow, policy-constrained
   *  follow-up case, not held items generally (see CommandConversations). */
  metadata?: { hold_kind?: string; proposed_reply?: string } | null
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
  conversations: ConversationSummary[]
  caye_active: boolean
  caye_muted_until: string | null
}

// Shared by CommandScreen (the panel tab) and FounderHome (the founder's
// landing view) so there's one fetch path against
// /api/founder/command-overview, not two copies drifting apart.
// weekOffset (0 = this week) lets CommandCalendar page through
// weeks — CommandScreen doesn't pass it and keeps its old "this week only"
// behavior.
export function useCommandOverview(workspaceId: string | null, weekOffset = 0) {
  const [data, setData] = useState<CommandOverview | null>(null)
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

  return { data, loading, error, refetch: load }
}
