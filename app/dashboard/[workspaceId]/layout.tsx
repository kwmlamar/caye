"use client"

import { useEffect, useState, use } from "react"
import { useRouter } from "next/navigation"
import Sidebar from "@/components/dashboard/Sidebar"
import CayePanel from "@/components/dashboard/CayePanel"
import CayeFab from "@/components/dashboard/CayeFab"
import { getSession, getSupabase } from "@/lib/supabase"
import { WorkspaceProvider, type WorkspaceMembership } from "@/lib/workspace-context"
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context"
import type { Customer } from "@/types/database"

interface ShellProps {
  children: React.ReactNode
  workspace: Customer
  workspaceId: string
  workspaces: WorkspaceMembership[]
  isOwner: boolean
}

// Separate inner component so it can access DashboardContext
function DashboardShell({ children, workspace, workspaceId, workspaces, isOwner }: ShellProps) {
  const { cayeOpen, setCayeOpen } = useDashboard()

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setCayeOpen(v => !v)
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [setCayeOpen])

  return (
    <WorkspaceProvider value={{ workspace, workspaceId, workspaces, isOwner }}>
      <div className="tc-root">
        <div className="tc-frame">
          <Sidebar workspaceId={workspaceId} />
          <div className={`tc-main${cayeOpen ? ' caye-open' : ''}`}>
            {children}
          </div>
          <CayePanel open={cayeOpen} onClose={() => setCayeOpen(false)} />
          {!cayeOpen && <CayeFab onClick={() => setCayeOpen(true)} />}
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
    <DashboardProvider>
      <DashboardShell
        workspace={workspace}
        workspaceId={workspaceId}
        workspaces={workspaces}
        isOwner={isOwner}
      >
        {children}
      </DashboardShell>
    </DashboardProvider>
  )
}
