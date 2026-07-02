"use client"

import { useEffect, useState, use, Suspense } from "react"
import { useRouter } from "next/navigation"
import Sidebar from "@/components/dashboard/Sidebar"
import ViewportRedirect from "@/components/mobile/ViewportRedirect"
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
              placements list built in — no shared Sidebar, no slide-out
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

  useEffect(() => {
    async function loadWorkspaceData() {
      try {
        const { session } = await getSession()
        if (!session) {
          router.push("/login")
          return
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

        setWorkspace(currentMembership.customer)
        setIsOwner(currentMembership.role === 'owner')
        setIsFounder(isFounderUserId(session.user.id))
        localStorage.setItem('lastActiveWorkspaceId', workspaceId)
        setLoading(false)
      } catch (err) {
        console.error("[WorkspaceLayout] loadWorkspaceData failed:", err)
        setLoading(false)
      }
    }

    loadWorkspaceData()
  }, [workspaceId, router])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--tc-bg-app)',
      }}>
        <p style={{ color: 'var(--tc-ink-mute)', fontSize: 13 }}>Loading workspace…</p>
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
