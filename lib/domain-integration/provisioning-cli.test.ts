import { describe, expect, it } from 'vitest'

import {
  connectionMatches,
  domainSecretEnvName,
  parseArgs,
} from '../../scripts/provision-bedrock-domain.mjs'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const companyId = '22222222-2222-4222-8222-222222222222'

function args(extra: string[] = []) {
  return [
    '--workspace-id', workspaceId,
    '--bedrock-company-id', companyId,
    '--bedrock-supabase-url', 'https://bedrock.example.supabase.co/',
    '--credential-ref', 'ods_bedrock_prod',
    ...extra,
  ]
}

describe('Bedrock production provisioning CLI', () => {
  it('is dry-run by default and normalizes only non-secret configuration', () => {
    expect(parseArgs(args())).toEqual({
      workspaceId,
      bedrockCompanyId: companyId,
      bedrockSupabaseUrl: 'https://bedrock.example.supabase.co',
      credentialRef: 'ods_bedrock_prod',
      apply: false,
    })
  })

  it('requires an explicit --apply before any Caye connection write can occur', () => {
    expect(parseArgs(args(['--apply'])).apply).toBe(true)
  })

  it('maps credential references only into the dedicated domain-secret namespace', () => {
    expect(domainSecretEnvName('ods_bedrock_prod')).toBe('DOMAIN_SECRET_ODS_BEDROCK_PROD')
    expect(() => domainSecretEnvName('../SUPABASE_SERVICE_ROLE_KEY')).toThrow(/credential_ref/)
    expect(() => domainSecretEnvName('stripe-secret')).toThrow(/credential_ref/)
  })

  it('treats only an exact active connection as idempotently provisioned', () => {
    const desired = parseArgs(args())
    const existing = {
      source_system: 'bedrock',
      external_tenant_id: companyId,
      status: 'active',
      credential_ref: 'ods_bedrock_prod',
      config: { supabase_url: 'https://bedrock.example.supabase.co/' },
    }

    expect(connectionMatches(existing, desired)).toBe(true)
    expect(connectionMatches({ ...existing, external_tenant_id: workspaceId }, desired)).toBe(false)
    expect(connectionMatches({ ...existing, status: 'paused' }, desired)).toBe(false)
    expect(connectionMatches({ ...existing, credential_ref: 'other_ref' }, desired)).toBe(false)
  })

  it('rejects malformed tenant ids and insecure remote URLs before touching a database', () => {
    expect(() => parseArgs([
      '--workspace-id', 'not-a-uuid',
      '--bedrock-company-id', companyId,
      '--bedrock-supabase-url', 'https://bedrock.example.supabase.co',
      '--credential-ref', 'ods_bedrock_prod',
    ])).toThrow(/workspace-id/)

    expect(() => parseArgs([
      '--workspace-id', workspaceId,
      '--bedrock-company-id', companyId,
      '--bedrock-supabase-url', 'http://bedrock.example.com',
      '--credential-ref', 'ods_bedrock_prod',
    ])).toThrow(/https/)
  })
})
