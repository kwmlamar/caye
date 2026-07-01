'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { getSession, getSupabase } from '@/lib/supabase'
import { WorkspaceProvider, type WorkspaceMembership } from '@/lib/workspace-context'
import { isFounderUserId } from '@/lib/founder'
import ServiceWorkerRegistrar from '@/components/mobile/ServiceWorkerRegistrar'
import ViewportRedirect from '@/components/mobile/ViewportRedirect'
import type { Customer } from '@/types/database'
import '../mobile.css'

/**
 * Mobile app shell. Reuses the same Supabase auth + workspace-resolution
 * flow as the desktop dashboard layout, but renders no desktop chrome —
 * the mobile screens supply their own tab navigation.
 */
export default function MobileLayout({
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
    async function load() {
      try {
        const { session } = await getSession()
        if (!session) {
          router.push('/login')
          return
        }

        const client = getSupabase()

        const { data: memberData } = await client
          .from('workspace_members')
          .select('workspace_id, role, customer:customers(*)')
          .eq('user_id', session.user.id)

        const validMemberships = (memberData || []).filter(
          (m: unknown) => (m as { customer: unknown }).customer !== null
        ) as unknown as WorkspaceMembership[]
        setWorkspaces(validMemberships)

        let currentMembership = validMemberships.find(m => m.workspace_id === workspaceId)

        // Fallback: direct customer lookup for the user's own workspace
        if (!currentMembership && workspaceId === session.user.id) {
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

        if (!currentMembership) {
          router.push(`/m/${session.user.id}`)
          return
        }

        setWorkspace(currentMembership.customer)
        setIsOwner(currentMembership.role === 'owner')
        setIsFounder(isFounderUserId(session.user.id))
        localStorage.setItem('lastActiveWorkspaceId', workspaceId)
        setLoading(false)
      } catch (err) {
        console.error('[MobileLayout] load failed:', err)
        setLoading(false)
      }
    }
    load()
  }, [workspaceId, router])

  if (loading) {
    return (
      <div className="m-boot">
        <span className="m-boot-mark">C</span>
        <p>Loading…</p>
      </div>
    )
  }

  if (!workspace) return null

  return (
    <WorkspaceProvider value={{ workspace, workspaceId, workspaces, isOwner, isFounder }}>
      <ServiceWorkerRegistrar />
      <ViewportRedirect mode="toDesktop" workspaceId={workspaceId} />
      <div className="m-viewport">{children}</div>
    </WorkspaceProvider>
  )
}
