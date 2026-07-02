'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'

export interface Escalation {
  id: string
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
}

export interface ConversationSummary {
  id: string
  channel_type: string
  customer_name: string | null
  last_message_preview: string | null
  last_message_at: string
  human_agent_enabled: boolean
  human_agent_reason: string | null
}

export interface CommandOverview {
  escalations: Escalation[]
  pending_escalation_count: number
  daily_cost: { day: string; cost_usd: number }[]
  total_cost_usd: number
  llm_call_count: number
  bookings: Booking[]
  week_start: string
  conversations: ConversationSummary[]
  whatsapp_outbound_enabled: boolean
}

// Shared by CommandScreen (the panel tab) and FounderHome (the founder's
// landing view) so there's one fetch path against
// /api/founder/command-overview, not two copies drifting apart.
export function useCommandOverview(workspaceId: string | null) {
  const [data, setData] = useState<CommandOverview | null>(null)
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
        const res = await fetch(`/api/founder/command-overview?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Failed to load')
        if (!cancelled) setData(json)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [workspaceId])

  return { data, loading, error }
}
