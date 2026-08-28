'use client'

import { useState, useEffect, useCallback, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { useCommandOverview } from '@/lib/useCommandOverview'
import { useWorkspacesActivity } from '@/lib/useWorkspacesActivity'
import { useTodayStats } from '@/lib/useTodayStats'
import { getSession } from '@/lib/supabase'
import type { FounderRailId } from '@/lib/types'
import { liveOperatorDisplayNames } from '@/lib/operator-display-name'
import CayeDirectThread from '@/components/dashboard/caye-direct/CayeDirectThread'
import InboxPage from './InboxPage'
import PeoplePage from './PeoplePage'
import WorkPage from './WorkPage'
import MemoryPage from './MemoryPage'
import DirectionPage from './DirectionPage'
import SettingsPage from './SettingsPage'
import SnapshotCard from './cards/SnapshotCard'
import CommandSidebar, { type ActiveView, type ThreadListItem, type LiveOperator } from './CommandSidebar'
import { ENV_BG, GRADIENT, focusResetCss } from '../surface'

const PAGE_IDS: FounderRailId[] = ['inbox', 'people', 'work', 'memory', 'direction', 'settings']

function storageKey(workspaceId: string): string {
  return `caye-command-selected-thread:${workspaceId}`
}

function sidebarStorageKey(): string {
  return 'caye-command-sidebar-collapsed'
}

/**
 * Caye Command — chat-first shell (2026-08-25 redesign). Caye Direct's
 * thread view is now the persistent main surface (it used to be a modal
 * overlay summoned on top of a multi-page Home); the old icon rail and the
 * overlay's own thread-history panel merge into one collapsible sidebar,
 * matching the Claude/ChatGPT app-shell reference this was modeled on —
 * fixed destinations (Inbox/People/Work/Memory/Settings) on top, conversations
 * below, a toggle at the top-left that fully hides the sidebar.
 *
 * There is no 'home' view any more. The old Home page's content (the
 * hero briefing, business pulse, attention queue) becomes the first entry
 * in Caye's card catalog — see SnapshotCard — pinned above the transcript
 * instead of living on its own page.
 *
 * "Team" visibility (an operator's real WhatsApp conversation with Caye —
 * Mrs. Max, Max) used to live behind a Chat/Live mode switch inside the old
 * modal, which made it easy to lose track of. It's now its own always-
 * visible sidebar section instead of a second mode to discover.
 *
 * Live agent-selected cards (Caye choosing to drop a card mid-reply) are a
 * separate, later piece of work — see SnapshotCard's doc comment for why
 * that's not wired here.
 */
export default function FounderHome() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspace, workspaceId, workspaces } = useWorkspace()
  const [weekOffset, setWeekOffset] = useState(0)
  const { data, revalidating, refetch } = useCommandOverview(workspaceId, weekOffset)
  const today = useTodayStats(workspaceId)
  const [isPending, startTransition] = useTransition()
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const { hasActivity } = useWorkspacesActivity(workspaces.map((m) => m.workspace_id), workspaceId)

  const [snapshotDismissed, setSnapshotDismissed] = useState(false)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  function goToConversation(conversationId: string | null) {
    setSelectedConversationId(conversationId)
    setActiveView({ type: 'page', id: 'inbox' })
  }

  // ── URL-synced view — only page destinations round-trip through ?rail=;
  // a thread/operator selection is local + localStorage-remembered, same
  // as the old CayeDirect overlay never put a thread id in the URL either.
  const rawRail = searchParams.get('rail')
  const [activeView, setActiveViewState] = useState<ActiveView>(() =>
    (rawRail && PAGE_IDS.includes(rawRail as FounderRailId))
      ? { type: 'page', id: rawRail as FounderRailId }
      : { type: 'thread', id: '' }
  )
  useEffect(() => {
    if (isPending) return
    if (rawRail && PAGE_IDS.includes(rawRail as FounderRailId)) {
      setActiveViewState({ type: 'page', id: rawRail as FounderRailId })
    } else {
      setActiveViewState((current) => current.type === 'page' ? { type: 'thread', id: '' } : current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRail, isPending])

  function setActiveView(next: ActiveView) {
    setActiveViewState(next)
    const params = new URLSearchParams(searchParams.toString())
    if (next.type === 'page') params.set('rail', next.id)
    else params.delete('rail')
    const qs = params.toString()
    startTransition(() => {
      router.replace(`/dashboard/${workspaceId}${qs ? `?${qs}` : ''}`, { scroll: false })
    })
  }

  function goToWorkspace(id: string) {
    if (id === workspaceId) return
    setPendingWorkspaceId(id)
    startTransition(() => {
      router.push(`/dashboard/${id}${activeView.type === 'page' ? `?rail=${activeView.id}` : ''}`)
    })
  }
  const highlightedWorkspaceId = (isPending && pendingWorkspaceId) || workspaceId

  // ── Sidebar collapse — persisted per browser, not per workspace; this
  // is a layout preference, not workspace state.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(sidebarStorageKey()) === '1') } catch {}
  }, [])
  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current
      try { window.localStorage.setItem(sidebarStorageKey(), next ? '1' : '0') } catch {}
      return next
    })
  }

  // ── Thread list — moved here from the old CayeDirect.tsx overlay, since
  // the sidebar (highlighting the active thread) and the main pane
  // (rendering it) both need this now that chat isn't a modal owning its
  // own isolated state.
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null)
  const [creating, setCreating] = useState(false)

  const loadThreads = useCallback(async (): Promise<ThreadListItem[] | null> => {
    const { session } = await getSession()
    if (!session) return null
    const url = `/api/founder/caye-direct/threads?workspaceId=${workspaceId}&status=active`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const json = await res.json()
    return res.ok ? (json.threads as ThreadListItem[]) : null
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    setThreads(null)
    async function load() {
      const list = await loadThreads()
      if (cancelled) return
      setThreads(list ?? [])
      let remembered: string | null = null
      try { remembered = window.localStorage.getItem(storageKey(workspaceId)) } catch {}
      const rememberedValid = remembered && (list ?? []).some((thread) => thread.id === remembered)
      const initialId = rememberedValid ? remembered : (list ?? [])[0]?.id ?? null
      if (initialId) setActiveViewState((current) => current.type === 'page' ? current : { type: 'thread', id: initialId })
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, loadThreads])

  // ── Operators ("Team") — read-only visibility into an operator's real
  // WhatsApp conversation with Caye. Ported from the old CayeDirect.tsx
  // overlay's Live mode, minus the mode switch: it's just always here.
  const [operators, setOperators] = useState<LiveOperator[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setOperators(null)
    async function loadOperators() {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch(`/api/founder/caye-operators?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await response.json()
      if (cancelled || !response.ok) return
      const list = (json.operators as LiveOperator[]).filter((operator) => operator.role !== 'founder')
      setOperators(list)
    }
    loadOperators()
    return () => { cancelled = true }
  }, [workspaceId])

  function selectThread(id: string) {
    try { window.localStorage.setItem(storageKey(workspaceId), id) } catch {}
    setActiveView({ type: 'thread', id })
  }

  function selectOperator(id: number) {
    setActiveView({ type: 'operator', id })
  }

  async function createThread() {
    setCreating(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/caye-direct/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json()
      if (!res.ok || !json.thread) return
      const thread: ThreadListItem = json.thread
      setThreads((current) => [thread, ...(current ?? [])])
      selectThread(thread.id)
    } finally {
      setCreating(false)
    }
  }

  function updateThreadMeta(id: string, meta: { title: string | null }) {
    setThreads((current) => (current ?? []).map((thread) => thread.id === id ? { ...thread, title: meta.title } : thread))
  }

  function archiveThread(id: string) {
    setThreads((current) => {
      const remaining = (current ?? []).filter((thread) => thread.id !== id)
      setActiveViewState((view) => (view.type === 'thread' && view.id === id)
        ? (remaining[0] ? { type: 'thread', id: remaining[0].id } : { type: 'thread', id: '' })
        : view)
      return remaining
    })
  }

  // The sidebar's "more" menu acts on a thread without it being open (the
  // one place besides CayeDirectThread's own header Archive button that
  // needs to hit the PATCH endpoint directly) — archiveThread above stays
  // the local-state-only sync CayeDirectThread's onArchive callback uses
  // after ITS OWN PATCH already succeeded.
  async function archiveThreadById(id: string) {
    const { session } = await getSession()
    if (session) {
      await fetch(`/api/founder/caye-direct/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workspaceId, status: 'archived' }),
      })
    }
    archiveThread(id)
  }

  async function renameThreadTitle(id: string, title: string) {
    updateThreadMeta(id, { title })
    const { session } = await getSession()
    if (!session) return
    await fetch(`/api/founder/caye-direct/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ workspaceId, title }),
    })
  }

  async function togglePinThread(id: string, pinned: boolean) {
    setThreads((current) => (current ?? []).map((thread) =>
      thread.id === id ? { ...thread, pinned_at: pinned ? new Date().toISOString() : null } : thread
    ))
    const { session } = await getSession()
    if (!session) return
    await fetch(`/api/founder/caye-direct/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ workspaceId, pinned }),
    })
  }

  async function deleteThreadPermanently(id: string) {
    setThreads((current) => {
      const remaining = (current ?? []).filter((thread) => thread.id !== id)
      setActiveViewState((view) => (view.type === 'thread' && view.id === id)
        ? (remaining[0] ? { type: 'thread', id: remaining[0].id } : { type: 'thread', id: '' })
        : view)
      return remaining
    })
    const { session } = await getSession()
    if (!session) return
    await fetch(`/api/founder/caye-direct/threads/${id}?workspaceId=${workspaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  }

  const selectedThread = activeView.type === 'thread' ? threads?.find((t) => t.id === activeView.id) ?? null : null
  const selectedOperator = activeView.type === 'operator' ? operators?.find((o) => o.id === activeView.id) ?? null : null
  const operatorLabels = liveOperatorDisplayNames(operators ?? [])

  return (
    <div className="caye-founder" style={{ position: 'relative', display: 'flex', height: '100%', background: ENV_BG, color: '#f4f4f5', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      <style>{`
        @keyframes caye-progress-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(360%); }
        }
        .caye-founder * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
        .caye-founder *::-webkit-scrollbar { width: 6px; height: 6px; }
        .caye-founder *::-webkit-scrollbar-track { background: transparent; }
        .caye-founder *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .caye-founder *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        ${focusResetCss}
      `}</style>

      <CommandSidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        activeView={activeView}
        onSelectPage={(id) => setActiveView({ type: 'page', id })}
        threads={threads}
        onSelectThread={selectThread}
        onNewThread={createThread}
        creatingThread={creating}
        onRenameThread={renameThreadTitle}
        onTogglePinThread={togglePinThread}
        onArchiveThread={archiveThreadById}
        onDeleteThread={deleteThreadPermanently}
        operators={operators}
        onSelectOperator={selectOperator}
        businessName={workspace.business_name ?? 'New signup'}
        workspaceStatus={workspace.status}
        workspaces={workspaces}
        activeWorkspaceId={highlightedWorkspaceId}
        onSelectWorkspace={goToWorkspace}
        hasActivity={hasActivity}
      />

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
          background:
            'radial-gradient(ellipse 900px 500px at 100% -10%, rgba(7,102,163,0.13), transparent 60%), ' +
            'radial-gradient(ellipse 620px 480px at 78% 20%, rgba(78,190,206,0.06), transparent 65%), ' +
            'radial-gradient(ellipse 700px 400px at -5% 110%, rgba(255,228,175,0.04), transparent 60%)',
        }} />

        {(isPending || revalidating) && (
          <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: 0, zIndex: 20, height: 2, overflow: 'hidden' }}>
            <div style={{ width: '38%', height: '100%', borderRadius: 2, background: GRADIENT, animation: 'caye-progress-slide 0.9s ease-in-out infinite' }} />
          </div>
        )}

        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          // Reserves horizontal room for the floating collapse toggle
          // (top-left, see CommandSidebar) — when the sidebar is open the
          // toggle sits inside its own row there instead, so this is only
          // needed once it's floating over the main pane's own top-left
          // corner, where every page/thread's own heading would otherwise
          // start flush against it. A left inset, not a top one — nothing
          // should visibly move down just because the sidebar collapsed.
          paddingLeft: collapsed ? 50 : 0,
          transition: 'padding-left 0.18s ease',
        }}>
          {activeView.type === 'page' ? (
            activeView.id === 'inbox' ? (
              <InboxPage workspaceId={workspaceId} selectedConversationId={selectedConversationId} onSent={refetch} />
            ) : activeView.id === 'people' ? (
              <PeoplePage workspaceId={workspaceId} onReviewConversation={goToConversation} />
            ) : activeView.id === 'work' ? (
              <WorkPage workspaceId={workspaceId} onSelectConversation={goToConversation} />
            ) : activeView.id === 'memory' ? (
              <MemoryPage workspaceId={workspaceId} />
            ) : activeView.id === 'direction' ? (
              <DirectionPage workspaceId={workspaceId} />
            ) : (
              <SettingsPage workspaceId={workspaceId} />
            )
          ) : activeView.type === 'operator' ? (
            selectedOperator ? (
              <CayeDirectThread
                key={selectedOperator.id}
                mode="operator"
                workspaceId={workspaceId}
                operatorId={selectedOperator.id}
                operatorLabel={operatorLabels.get(selectedOperator.id) || 'Operator'}
                scrollToLatest
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: 13 }}>
                {operators === null ? 'Loading…' : 'Operator not found.'}
              </div>
            )
          ) : selectedThread ? (
            <CayeDirectThread
              key={selectedThread.id}
              mode="thread"
              workspaceId={workspaceId}
              threadId={selectedThread.id}
              threadTitle={selectedThread.title}
              autoFocusComposer
              composerVisible
              scrollToLatest
              onThreadMeta={(meta) => updateThreadMeta(selectedThread.id, meta)}
              onArchive={() => archiveThread(selectedThread.id)}
              leadingCard={!snapshotDismissed ? (
                <SnapshotCard
                  data={data}
                  today={today}
                  weekLabel={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'}
                  onReviewAttention={goToConversation}
                  onDismiss={() => setSnapshotDismissed(true)}
                />
              ) : undefined}
            />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: 13 }}>
              {threads === null ? 'Loading…' : 'Start a conversation with Caye.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
