import 'server-only'

import { DomainIdentityError } from './authority'

/**
 * Materialises a domain connection's credential.
 *
 * `domain_source_connections.credential_ref` stores a NAME, never a value, so
 * something has to turn that name into a secret. This is that something, and
 * it is deliberately the narrowest possible implementation: a reference is a
 * key into the server's own environment, under a fixed prefix.
 *
 * The prefix is the security property, not decoration. `credential_ref` is
 * database content, and a database row that could name ANY environment
 * variable would turn "read a connection" into "read this process's entire
 * secret material" — Stripe keys, service-role keys, provider tokens. The
 * prefix plus the character whitelist below mean a malicious or merely
 * mistaken row can only ever address secrets that were provisioned for this
 * purpose.
 */

export const DOMAIN_SECRET_ENV_PREFIX = 'DOMAIN_SECRET_'

/** Lowercase alphanumerics and underscores. No dots, no dashes, no traversal. */
const CREDENTIAL_REF_PATTERN = /^[a-z0-9_]{1,64}$/

export class DomainCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainCredentialError'
  }
}

export function domainSecretEnvName(credentialRef: string): string {
  const ref = typeof credentialRef === 'string' ? credentialRef.trim().toLowerCase() : ''
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new DomainCredentialError(
      'credential_ref must be 1-64 characters of [a-z0-9_]; refusing to resolve an arbitrary environment name'
    )
  }
  return `${DOMAIN_SECRET_ENV_PREFIX}${ref.toUpperCase()}`
}

/**
 * Reads the secret a connection names. Throws rather than returning null: a
 * connection that is marked active but whose secret is absent is a
 * misconfiguration, and continuing with no credential would either fail
 * confusingly deeper in a client library or, worse, fall back to some ambient
 * default belonging to a different tenant.
 *
 * The error deliberately names the environment variable and never the value.
 */
export function resolveDomainSecret(
  credentialRef: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!credentialRef || !credentialRef.trim()) {
    throw new DomainCredentialError('domain connection has no credential_ref')
  }
  const name = domainSecretEnvName(credentialRef)
  const value = env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainCredentialError(`domain connection secret ${name} is not set`)
  }
  return value
}

/** Reads a non-secret string off a connection's `config` blob. */
export function requireConnectionConfigString(
  config: Record<string, unknown>,
  key: string,
  sourceSystem: string
): string {
  const value = config?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainIdentityError(`${sourceSystem} connection config is missing "${key}"`)
  }
  return value.trim()
}
