/**
 * Sales is an internal Caye capability, not a second user-facing agent.
 * Workspace kind is resolved once at the boundary; callers consume this
 * capability marker instead of scattering internal_sales checks.
 */
export interface SalesCapability {
  readonly kind: 'sales_acquisition'
}

export const SALES_CAPABILITY: SalesCapability = { kind: 'sales_acquisition' }

export function resolveSalesCapability(workspace: { workspace_kind: string | null } | null | undefined): SalesCapability | null {
  return workspace?.workspace_kind === 'internal_sales' ? SALES_CAPABILITY : null
}

export function hasSalesCapability(workspace: { workspace_kind: string | null } | null | undefined): boolean {
  return resolveSalesCapability(workspace) !== null
}
