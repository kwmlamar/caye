import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/founder', () => ({ isFounderUserId: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServerClient: vi.fn(), createServiceClient: vi.fn() }))

import { requireFreightWorkspaceAuthority, type FreightAuthorityDependencies } from './authorization'

const request = new Request('https://example.test') as never
function dependencies(userId: string | null, founder: boolean, memberships: Record<string, string>): FreightAuthorityDependencies {
  return {
    authenticate: vi.fn().mockResolvedValue(userId),
    isFounder: vi.fn().mockReturnValue(founder),
    membershipRole: vi.fn(async (id, workspaceId) => id === userId ? memberships[workspaceId] ?? null : null),
  }
}

describe('freight workspace authority', () => {
  it('allows the correct workspace owner to review and approve', async () => {
    await expect(requireFreightWorkspaceAuthority(request, 'workspace-a', dependencies('wallace', false, { 'workspace-a': 'owner' }))).resolves.toEqual({ userId: 'wallace', actorKind: 'owner' })
  })

  it('preserves the existing founder privilege', async () => {
    await expect(requireFreightWorkspaceAuthority(request, 'workspace-a', dependencies('founder', true, {}))).resolves.toEqual({ userId: 'founder', actorKind: 'founder' })
  })

  it.each([
    ['an unrelated member', 'workspace-a', dependencies('member', false, { 'workspace-a': 'member' })],
    ['an owner of another workspace', 'workspace-a', dependencies('owner-b', false, { 'workspace-b': 'owner' })],
    ['a forged workspace id', 'forged-workspace', dependencies('wallace', false, { 'workspace-a': 'owner' })],
  ])('denies %s', async (_label, workspaceId, deps) => {
    await expect(requireFreightWorkspaceAuthority(request, workspaceId, deps)).resolves.toBeNull()
  })
})
