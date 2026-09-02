import { describe, expect, it } from 'vitest'

import { DomainCredentialError, domainSecretEnvName, resolveDomainSecret } from './secrets'

describe('domain connection secrets', () => {
  const env = {
    DOMAIN_SECRET_BEDROCK_ODS: 'service-role-value',
    SUPABASE_SERVICE_ROLE_KEY: 'caye-own-service-role',
    STRIPE_SECRET_KEY: 'sk_live_should_never_be_reachable',
  } as unknown as NodeJS.ProcessEnv

  it('maps a credential ref onto its prefixed environment variable', () => {
    expect(domainSecretEnvName('bedrock_ods')).toBe('DOMAIN_SECRET_BEDROCK_ODS')
    expect(domainSecretEnvName('  Bedrock_ODS ')).toBe('DOMAIN_SECRET_BEDROCK_ODS')
    expect(resolveDomainSecret('bedrock_ods', env)).toBe('service-role-value')
  })

  /**
   * `credential_ref` is database content. If a row could name any environment
   * variable, "read this workspace's connection" would become "read this
   * process's entire secret material".
   */
  it('cannot be steered onto an unrelated secret', () => {
    for (const attempt of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'stripe_secret_key',
      '../STRIPE_SECRET_KEY',
      'bedrock-ods',
      'bedrock.ods',
      'bedrock ods',
      'a'.repeat(65),
      '',
      '   ',
    ]) {
      expect(() => resolveDomainSecret(attempt, env)).toThrow(DomainCredentialError)
    }
    // Even the legal-looking form only ever reaches the prefixed namespace.
    expect(() => resolveDomainSecret('stripe_secret_key', env)).toThrow(/DOMAIN_SECRET_STRIPE_SECRET_KEY is not set/)
  })

  it('fails closed on a missing or absent credential rather than falling back', () => {
    expect(() => resolveDomainSecret(null, env)).toThrow(/no credential_ref/)
    expect(() => resolveDomainSecret('bedrock_absent', env)).toThrow(/DOMAIN_SECRET_BEDROCK_ABSENT is not set/)
  })

  it('never puts the secret value in the error', () => {
    try {
      resolveDomainSecret('bedrock_absent', env)
      throw new Error('should have thrown')
    } catch (error) {
      expect(String(error)).not.toContain('service-role-value')
    }
  })
})
