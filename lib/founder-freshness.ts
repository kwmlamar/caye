'use client'

import { useEffect, useRef } from 'react'

/**
 * Local staleness bus for the founder console.
 *
 * The console's panels each fetch once on mount and then never again, so
 * anything Caye does in the background — drafting outreach leads, an
 * inbound WhatsApp/email landing, a booking being written — was invisible
 * until a full page reload. Panels are siblings with no coordination of
 * their own (same reason selectedConversationId lives up in FounderHome),
 * and the producer of a change is usually three components away from the
 * panels that care about it.
 *
 * So: producers call emitStale(workspaceId, topics); the data hooks
 * subscribe to the topics they own and refetch themselves. No prop
 * drilling through CayeDirect -> CayeDirectThread, and every consumer of a
 * hook gets the behaviour (CommandScreen benefits from useCommandOverview
 * subscribing, not just FounderHome).
 *
 * This is deliberately in-tab only — one browser tab telling itself what
 * it just caused. It is the seam a real transport (a /api/founder/changes
 * watermark poll, then Supabase Broadcast) plugs into later: those would
 * call emitStale from a single connection-owning hook and every panel
 * below would light up without further changes.
 *
 * Module scope rather than context, for the reason documented on
 * inFlightRuns in CayeDirectThread.tsx: switching workspaces navigates to
 * a new /dashboard/[workspaceId] route and remounts the whole subtree, so
 * there is no in-tree place to hold this that survives.
 */

export type FreshnessTopic =
  | 'conversations'
  | 'bookings'
  | 'escalations'
  | 'cost'
  | 'contacts'

/** Everything a Caye Direct turn could plausibly have touched. She has
 *  tools that create leads and drafts (conversations), book and reschedule
 *  (bookings), resolve holds (escalations), and add contacts — and the
 *  turn's text doesn't tell us which ran, so a settled turn invalidates
 *  the lot. Each topic is one cheap refetch of an already-loaded panel. */
export const ALL_TOPICS: FreshnessTopic[] = [
  'conversations', 'bookings', 'escalations', 'cost', 'contacts',
]

interface Subscription {
  workspaceId: string
  topics: Set<FreshnessTopic>
  notify: () => void
}

const subscriptions = new Set<Subscription>()

/** Marks topics stale for a workspace. Each matching subscriber is
 *  notified once, however many of its topics were named.
 *
 *  Iterates a copy: a subscriber is free to unsubscribe (or mount
 *  something that subscribes) from inside its own notify without
 *  invalidating the iteration. */
export function emitStale(workspaceId: string, topics: FreshnessTopic[]): void {
  for (const sub of [...subscriptions]) {
    if (sub.workspaceId !== workspaceId) continue
    if (topics.some((t) => sub.topics.has(t))) sub.notify()
  }
}

/** Framework-free half of useFreshness — returns an unsubscribe fn.
 *  Split out so the bus is unit-testable without a DOM, and so a future
 *  transport (watermark poll, Supabase Broadcast) can drive it from
 *  outside React. */
export function subscribeStale(
  workspaceId: string,
  topics: FreshnessTopic[],
  notify: () => void
): () => void {
  const sub: Subscription = { workspaceId, topics: new Set(topics), notify }
  subscriptions.add(sub)
  return () => { subscriptions.delete(sub) }
}

/**
 * Refetch `onStale` whenever one of `topics` is marked stale for this
 * workspace.
 *
 * `topics` is expected to be a stable literal at the call site; it's
 * reduced to a string key so a fresh array each render doesn't churn the
 * subscription. `onStale` is held in a ref so callers don't have to
 * memoize it to avoid resubscribing.
 */
export function useFreshness(
  workspaceId: string | null,
  topics: FreshnessTopic[],
  onStale: () => void
): void {
  const onStaleRef = useRef(onStale)
  onStaleRef.current = onStale
  const topicsKey = topics.join(',')

  useEffect(() => {
    if (!workspaceId) return
    return subscribeStale(
      workspaceId,
      topicsKey.split(',') as FreshnessTopic[],
      () => onStaleRef.current()
    )
  }, [workspaceId, topicsKey])
}

/** Don't refetch on focus if we already fetched this recently — tabbing
 *  between windows, or a click that happens to restore focus, shouldn't
 *  each cost a round of panel refetches. */
const FOCUS_REFRESH_COOLDOWN_MS = 10_000

/**
 * Refetch when the tab comes back to the foreground.
 *
 * Covers the case the staleness bus structurally can't: changes that
 * happened while this tab was in the background, caused by something that
 * isn't this tab (an inbound message, a cron run, Caye acting on a
 * WhatsApp instruction from the founder's phone). Coming back to a
 * console showing minutes-old state is most of what reads as "it doesn't
 * update".
 *
 * Listens to both visibilitychange and focus: the first covers tab
 * switches within a window, the second covers switching between apps,
 * where the tab was never hidden.
 */
export function useRevalidateOnFocus(onFocus: () => void, enabled = true): void {
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const lastRunRef = useRef(0)

  useEffect(() => {
    if (!enabled) return

    function maybeRun() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRunRef.current < FOCUS_REFRESH_COOLDOWN_MS) return
      lastRunRef.current = now
      onFocusRef.current()
    }

    document.addEventListener('visibilitychange', maybeRun)
    window.addEventListener('focus', maybeRun)
    return () => {
      document.removeEventListener('visibilitychange', maybeRun)
      window.removeEventListener('focus', maybeRun)
    }
  }, [enabled])
}
