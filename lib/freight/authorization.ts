import 'server-only'
import type { NextRequest } from 'next/server'
import { isFounderUserId } from '@/lib/founder'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

export type FreightAuthority = {
  userId: string
  actorKind: 'founder' | 'owner'
}

export type FreightAuthorityDependencies = {
  authenticate: (req: NextRequest) => Promise<string | null>
  membershipRole: (userId: string, workspaceId: string) => Promise<string | null>
  isFounder: (userId: string) => boolean
}

const productionDependencies: FreightAuthorityDependencies = {
  async authenticate(req) {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return null
    const { data: { user } } = await createServerClient(token).auth.getUser()
    return user?.id ?? null
  },
  async membershipRole(userId, workspaceId) {
    const { data } = await createServiceClient()
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()
    return data?.role ?? null
  },
  isFounder: isFounderUserId,
}

/** Freight-only authority gate. It deliberately does not alter founder-only dashboard routes. */
export async function requireFreightWorkspaceAuthority(
  req: NextRequest,
  workspaceId: string,
  dependencies: FreightAuthorityDependencies = productionDependencies,
): Promise<FreightAuthority | null> {
  const userId = await dependencies.authenticate(req)
  if (!userId) return null
  if (dependencies.isFounder(userId)) return { userId, actorKind: 'founder' }
  const role = await dependencies.membershipRole(userId, workspaceId)
  return role === 'owner' ? { userId, actorKind: 'owner' } : null
}
