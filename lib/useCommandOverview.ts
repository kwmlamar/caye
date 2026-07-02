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

export interface CommandOverview {
  escalations: Escalation[]
  pending_escalation_count: number
  daily_cost: { day: string; cost_usd: number }[]
  total_cost_usd: number
  llm_call_count: number
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
