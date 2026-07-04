"use client"

import { useEffect, useRef, useState, use, Suspense } from "react"
import { useRouter } from "next/navigation"
import Sidebar from "@/components/dashboard/Sidebar"
import ViewportRedirect from "@/components/mobile/ViewportRedirect"
import { CayeMark } from "@/components/brand/CayeMark"
import { getSession, getSupabase } from "@/lib/supabase"
import { WorkspaceProvider, type WorkspaceMembership } from "@/lib/workspace-context"
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context"
import { isFounderUserId } from "@/lib/founder"
import type { Customer } from "@/types/database"

interface ShellProps {
  children: React.ReactNode
  workspace: Customer
  workspaceId: string
  workspaces: WorkspaceMembership[]
  isOwner: boolean
  isFounder: boolean
}

// Separate inner component so it can access DashboardContext
function DashboardShell({ children, workspace, workspaceId, workspaces, isOwner, isFounder }: ShellProps) {
  const { panelOpen, setPanelOpen, sidebarExpanded, setSidebarExpanded } = useDashboard()

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setPanelOpen(!panelOpen)
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [panelOpen, setPanelOpen])

  return (
    <WorkspaceProvider value={{ workspace, workspaceId, workspaces, isOwner, isFounder }}>
      <ViewportRedirect mode="toMobile" workspaceId={workspaceId} />
      <div className="tc-root">
        <div className="tc-frame">
          {/* Founder gets one full-page view (FounderHome) with its own
              workspaces list built in — no shared Sidebar, no slide-out
              CayePanel. Owners (e.g. Karenda) keep both, untouched. */}
          {!isFounder && <Sidebar workspaceId={workspaceId} />}
          <div className={`tc-main${panelOpen ? ' caye-open' : ''}${!isFounder && !sidebarExpanded ? ' sb-collapsed' : ''}`} style={{ position: 'relative' }}>
            {!isFounder && !sidebarExpanded && (
              <button
                onClick={() => setSidebarExpanded(true)}
                className="sb-expand-trigger-btn"
                title="Expand sidebar"
                style={{
                  position: 'absolute',
                  top: 12,
                  left: 16,
                  zIndex: 40,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(14, 26, 26, 0.7)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(14, 26, 26, 0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12"></line>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
              </button>
            )}
            {children}
          </div>
        </div>
      </div>
    </WorkspaceProvider>
  )
}

export default function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspaceId: string }>
}) {
  const router = useRouter()
  const { workspaceId } = use(params)
  const [workspace, setWorkspace] = useState<Customer | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [isFounder, setIsFounder] = useState(false)
  const [loading, setLoading] = useState(true)
  // Mirrors `workspaces` without the closure-staleness risk of reading
  // state directly inside an effect keyed on a different dependency.
  const workspacesRef = useRef<WorkspaceMembership[]>([])
  // Founder's console is dark, the owner dashboard is light — a cold
  // start (refresh/deep link) has to guess which one to paint before
  // session/role resolve. Remembering the last resolved theme means the
  // guess is right on every visit after the first.
  const [themeHint] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem('cayeDashboardTheme') as 'dark' | 'light') ?? 'dark'
  })

  useEffect(() => {
    async function loadWorkspaceData() {
      try {
        const { session } = await getSession()
        if (!session) {
          router.push("/login")
          return
        }

        // Switching between workspaces the founder/owner has already been
        // shown (the common case — clicking another row in the Workspaces
        // list) needs zero network round trip: workspace_members was
        // fetched with the customer row joined in, so the full record is
        // already sitting in workspacesRef. Paint it immediately — no
        // "Loading workspace…" flash — then let the fetch below silently
        // revalidate in the background.
        const cached = workspacesRef.current.find((m) => m.workspace_id === workspaceId)
        if (cached) {
          const founder = isFounderUserId(session.user.id)
          setWorkspace(cached.customer)
          setIsOwner(cached.role === 'owner')
          setIsFounder(founder)
          setLoading(false)
          localStorage.setItem('cayeDashboardTheme', founder ? 'dark' : 'light')
        }

        const client = getSupabase()

        // Fetch all workspaces the user is a member of
        const { data: memberData, error: memberErr } = await client
          .from('workspace_members')
          .select(`workspace_id, role, customer:customers(*)`)
          .eq('user_id', session.user.id)

        if (memberErr || !memberData || memberData.length === 0) {
          if (workspaceId !== session.user.id) {
            router.push(`/dashboard/${session.user.id}`)
            return
          }
          // Bootstrap workspace_members if missing
          await client.from("workspace_members").upsert({
            workspace_id: session.user.id,
            user_id: session.user.id,
            role: "owner",
          }, { onConflict: "workspace_id,user_id" })
        }

        const validMemberships = (memberData || [])
          .filter((m: unknown) => (m as { customer: unknown }).customer !== null) as unknown as WorkspaceMembership[]
        setWorkspaces(validMemberships)
        workspacesRef.current = validMemberships

        // Verify user is a member of this workspaceId
        let currentMembership = validMemberships.find(m => m.workspace_id === workspaceId)

        // Fallback: re-fetch or direct customer lookup for own workspace
        if (!currentMembership && workspaceId === session.user.id) {
          const { data: refetch } = await client
            .from('workspace_members')
            .select('workspace_id, role, customer:customers(*)')
            .eq('workspace_id', workspaceId)
            .eq('user_id', session.user.id)
            .maybeSingle()

          if ((refetch as unknown as WorkspaceMembership | null)?.customer) {
            currentMembership = refetch as unknown as WorkspaceMembership
          } else {
            const { data: directCustomer } = await client
              .from('customers')
              .select('*')
              .eq('id', session.user.id)
              .maybeSingle()
            if (directCustomer) {
              currentMembership = {
                workspace_id: session.user.id,
                role: 'owner',
                customer: directCustomer as Customer,
              }
            }
          }
        }

        if (!currentMembership) {
          router.push(`/dashboard/${session.user.id}`)
          return
        }

        const founder = isFounderUserId(session.user.id)
        setWorkspace(currentMembership.customer)
        setIsOwner(currentMembership.role === 'owner')
        setIsFounder(founder)
        localStorage.setItem('lastActiveWorkspaceId', workspaceId)
        localStorage.setItem('cayeDashboardTheme', founder ? 'dark' : 'light')
        setLoading(false)
      } catch (err) {
        console.error("[WorkspaceLayout] loadWorkspaceData failed:", err)
        setLoading(false)
      }
    }

    loadWorkspaceData()
  }, [workspaceId, router])

  // Only the true cold start (no cached workspace to paint yet — first
  // visit this session, or a hard refresh/deep link) ever reaches this.
  // Ordinary placement-switching resolves `workspace` from cache above
  // before this can render, so it never flashes mid-switch.
  if (loading && !workspace) {
    const dark = themeHint === 'dark'
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        background: dark ? '#09090b' : 'var(--tc-bg-app)',
      }}>
        <style>{`
          @keyframes caye-loading-pulse {
            0%, 100% { opacity: 0.5; transform: scale(0.94); }
            50% { opacity: 1; transform: scale(1); }
          }
        `}</style>
        <div style={{ animation: 'caye-loading-pulse 1.4s ease-in-out infinite' }}>
          <CayeMark size={36} />
        </div>
        <p style={{
          color: dark ? '#71717a' : 'var(--tc-ink-mute)',
          fontSize: 12.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Loading workspace…
        </p>
      </div>
    )
  }

  if (!workspace) return null

  return (
    <Suspense fallback={null}>
      <DashboardProvider>
        <DashboardShell
          workspace={workspace}
          workspaceId={workspaceId}
          workspaces={workspaces}
          isOwner={isOwner}
          isFounder={isFounder}
        >
          {children}
        </DashboardShell>
      </DashboardProvider>
    </Suspense>
  )
}
