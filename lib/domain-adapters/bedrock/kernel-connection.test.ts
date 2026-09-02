import { describe, expect, it } from 'vitest'

import type { DomainConnectionResolver, DomainSourceConnection } from '@/lib/domain/connections'
import { KernelBedrockConnectionResolver, toBedrockConnection } from './kernel-connection'

const env = { DOMAIN_SECRET_BEDROCK_ODS: 'bedrock-service-role' } as unknown as NodeJS.ProcessEnv

function connection(overrides: Partial<DomainSourceConnection> = {}): DomainSourceConnection {
  return {
    id: 'conn-1',
    workspaceId: 'ws-1',
    sourceSystem: 'bedrock',
    externalTenantId: 'company-a',
    status: 'active',
    credentialRef: 'bedrock_ods',
    config: { supabase_url: 'https://bedrock.invalid' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const resolverFor = (value: DomainSourceConnection | null): DomainConnectionResolver => ({
  resolve: async () => value,
})

describe('KernelBedrockConnectionResolver', () => {
  it('binds a workspace to its Bedrock company via the kernel connection row', async () => {
    const resolved = await new KernelBedrockConnectionResolver(resolverFor(connection()), env).resolve('ws-1')
    expect(resolved).toEqual({
      workspaceId: 'ws-1',
      companyId: 'company-a',
      supabaseUrl: 'https://bedrock.invalid',
      serviceRoleKey: 'bedrock-service-role',
    })
  })

  it('returns null when the workspace has no connection, so the adapter fails closed', async () => {
    expect(await new KernelBedrockConnectionResolver(resolverFor(null), env).resolve('ws-1')).toBeNull()
    expect(await new KernelBedrockConnectionResolver(resolverFor(connection()), env).resolve('  ')).toBeNull()
  })

  it('withholds a paused or revoked connection', async () => {
    for (const status of ['paused', 'revoked'] as const) {
      const resolver = new KernelBedrockConnectionResolver(resolverFor(connection({ status })), env)
      expect(await resolver.resolve('ws-1')).toBeNull()
    }
  })

  it('refuses a connection that cannot produce a scoped, credentialed client', async () => {
    expect(() => toBedrockConnection(connection({ externalTenantId: '' }), env)).toThrow(/external_tenant_id/)
    expect(() => toBedrockConnection(connection({ config: {} }), env)).toThrow(/supabase_url/)
    expect(() => toBedrockConnection(connection({ credentialRef: null }), env)).toThrow(/credential_ref/)
    expect(() => toBedrockConnection(connection({ sourceSystem: 'quickbooks' }), env)).toThrow(/expected a bedrock connection/)
  })

  it('keeps the tenant id out of anything but the connection', () => {
    // external_tenant_id is the binding, never part of entity identity. If it
    // ever leaks into a ref-shaped object this assertion is the tripwire.
    const bedrock = toBedrockConnection(connection(), env)
    expect(Object.keys(bedrock).sort()).toEqual(['companyId', 'serviceRoleKey', 'supabaseUrl', 'workspaceId'])
  })
})
