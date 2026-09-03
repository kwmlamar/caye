export const SEMANTIC_SCOPES = [
  'customer_business',
  'customer_operator',
  'founder_admin',
  'platform_test',
  'engineering_task',
  'personal_direct_task',
  'system_internal',
  'legacy_unclassified',
] as const

export type SemanticScope = (typeof SEMANTIC_SCOPES)[number]

export const SEMANTIC_SCOPE_VERSION = 1 as const

const SEMANTIC_SCOPE_SET = new Set<string>(SEMANTIC_SCOPES)

export function isSemanticScope(value: unknown): value is SemanticScope {
  return typeof value === 'string' && SEMANTIC_SCOPE_SET.has(value)
}

/**
 * Semantic scope derivation is intentionally monotonic.
 *
 * A child may retain the parent's scope. Customer-business work may also
 * produce an internal derivative, but an excluded/internal/legacy source may
 * never become customer_business through ordinary derivation. Any future
 * trusted promotion path must be explicit and separate from this function.
 */
export function canDeriveScope(parentScope: SemanticScope, requestedChildScope: SemanticScope): boolean {
  if (parentScope === requestedChildScope) return true
  return parentScope === 'customer_business' && requestedChildScope === 'system_internal'
}

export interface ScopeDerivationInput {
  parentWorkspaceId: string
  childWorkspaceId: string
  parentScope: SemanticScope
  requestedChildScope: SemanticScope
}

export function assertScopeDerivation(input: ScopeDerivationInput): void {
  if (input.parentWorkspaceId !== input.childWorkspaceId) {
    throw new Error('Semantic scope derivation cannot cross workspaces')
  }
  if (!canDeriveScope(input.parentScope, input.requestedChildScope)) {
    throw new Error(`Semantic scope cannot widen from ${input.parentScope} to ${input.requestedChildScope}`)
  }
}
