'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'

export interface ConversationSummary {
  id: string
  channel_type: string
  customer_name: string | null
  /** Raw address/handle (email, phone) — shown when customer_name is
   *  null instead of a bare "Unknown", and as secondary identity in the
   *  thread header. */
  customer_id: string | null
  last_message_preview: string | null
  last_message_at: string
  human_agent_enabled: boolean
  human_agent_reason: string | null
  /** hold_kind==='outreach_followup' + proposed_reply is what lets the
   *  compose box auto-fill — scoped to this one narrow, policy-constrained
   *  follow-up case, not held items generally (see CommandConversations). */
  metadata?: { hold_kind?: string; proposed_reply?: string } | null
}

export type ConversationFilter = 'all' | 'review'

interface State {
  items: ConversationSummary[]
  nextCursor: string | null
  reviewCount: number
  loading: boolean
  loadingMore: boolean
  error: string | null
}

// Fetches one conversation by id, scoped to the workspace — used when a
// sibling panel (CommandCalendar's booking click-through) needs to jump
// to a conversation that isn't in whatever page is currently loaded.
export async function fetchConversationById(
  workspaceId: string,
  id: string
): Promise<ConversationSummary | null> {
  const { session } = await getSession()
  if (!session) return null
  const params = new URLSearchParams({ workspaceId, id })
  const res = await fetch(`/api/founder/conversations?${params.toString()}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) return null
  const json = await res.json() as { conversation: ConversationSummary | null }
  return json.conversation ?? null
}

// Keyset-paginated, server-filtered/-searched conversation list backing
// CommandConversations. Replaces the old flat top-30 fetched inline by
// /api/founder/command-overview, which silently hid older held
// conversations and only ever searched whatever page was already loaded.
export function useFounderConversations(
  workspaceId: string | null,
  filter: ConversationFilter,
  q: string
) {
  const [state, setState] = useState<State>({
    items: [], nextCursor: null, reviewCount: 0, loading: true, loadingMore: false, error: null,
  })
  // Guards against a stale response (e.g. a slow first-page fetch that
  // resolves after the user has already switched tabs) clobbering newer
  // state — only the most recently issued request is allowed to write.
  const requestIdRef = useRef(0)

  const fetchPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (!workspaceId) return
    const requestId = ++requestIdRef.current
    setState((s) => append ? { ...s, loadingMore: true } : { ...s, loading: true, error: null })

    const { session } = await getSession()
    if (!session) {
      if (requestId !== requestIdRef.current) return
      setState((s) => ({ ...s, loading: false, loadingMore: false, error: 'Not signed in' }))
      return
    }

    const params = new URLSearchParams({ workspaceId, filter })
    if (q) params.set('q', q)
    if (cursor) params.set('cursor', cursor)

    try {
      const res = await fetch(`/api/founder/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (requestId !== requestIdRef.current) return
      if (!res.ok) throw new Error(json.error || 'Failed to load conversations')
      setState((s) => ({
        items: append ? [...s.items, ...json.conversations] : json.conversations,
        nextCursor: json.nextCursor,
        reviewCount: json.reviewCount,
        loading: false,
        loadingMore: false,
        error: null,
      }))
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setState((s) => ({
        ...s, loading: false, loadingMore: false,
        error: err instanceof Error ? err.message : 'Failed to load',
      }))
    }
  }, [workspaceId, filter, q])

  useEffect(() => {
    fetchPage(null, false)
  }, [fetchPage])

  const loadMore = useCallback(() => {
    if (!state.nextCursor || state.loadingMore || state.loading) return
    fetchPage(state.nextCursor, true)
  }, [fetchPage, state.nextCursor, state.loadingMore, state.loading])

  // Background refresh: pulls the newest page and merges it over what's
  // loaded, without touching `loading`.
  //
  // Deliberately not fetchPage(null, false), which is the obvious move and
  // wrong twice over — it flips `loading`, blanking the list to a skeleton
  // under a founder who's reading it, and it throws away every page loaded
  // past the first, silently scrolling them back to the top. Merging keeps
  // deeper pages and scroll position intact; new conversations (the case
  // this exists for — Caye drafting a batch of outreach leads) arrive at
  // the top in server order.
  //
  // Unlike fetchPage this does NOT claim requestIdRef, so it can't cancel a
  // real fetch in flight; it just declines to write if one has started
  // since. A refresh losing a race to a filter switch is correct.
  const refresh = useCallback(async () => {
    if (!workspaceId) return
    const issuedAt = requestIdRef.current

    const { session } = await getSession()
    if (!session || issuedAt !== requestIdRef.current) return

    const params = new URLSearchParams({ workspaceId, filter })
    if (q) params.set('q', q)

    try {
      const res = await fetch(`/api/founder/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok || issuedAt !== requestIdRef.current) return
      const fresh = json.conversations as ConversationSummary[]
      const freshIds = new Set(fresh.map((c) => c.id))
      setState((s) => ({
        ...s,
        items: [...fresh, ...s.items.filter((c) => !freshIds.has(c.id))],
        reviewCount: json.reviewCount,
        error: null,
      }))
    } catch {
      // Silent. A dropped background refresh shouldn't replace a list the
      // founder is reading with an error state — the next one will land.
    }
  }, [workspaceId, filter, q])

  useFreshness(workspaceId, ['conversations'], refresh)
  useRevalidateOnFocus(refresh)

  // Patches or prepends a single conversation without disturbing scroll
  // position or the rest of the loaded page — used after a manual send
  // (which flips human_agent_enabled server-side) and for the booking
  // click-through jump landing on a conversation outside the loaded page.
  const upsert = useCallback((conv: ConversationSummary) => {
    setState((s) => {
      const idx = s.items.findIndex((c) => c.id === conv.id)
      if (idx === -1) return { ...s, items: [conv, ...s.items] }
      const items = s.items.slice()
      items[idx] = conv
      return { ...s, items }
    })
  }, [])

  // Drops a conversation from the loaded page — used when a send flips a
  // conversation out of the current tab's filter (e.g. it leaves the
  // Review tab once human_agent_enabled clears) so it doesn't linger
  // until the next full refetch.
  const remove = useCallback((id: string) => {
    setState((s) => ({ ...s, items: s.items.filter((c) => c.id !== id) }))
  }, [])

  return { ...state, loadMore, upsert, remove, refresh }
}
