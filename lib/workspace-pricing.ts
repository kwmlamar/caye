import 'server-only'

/**
 * Manually-maintained Stripe customer ID per workspace. Backs the Cost
 * page's live "who's actually paying, and how much" lookup
 * (lib/stripe.ts's getActiveSubscriptionSummary) — customers.
 * stripe_customer_id exists in the schema but nothing populates it (no
 * webhook/sync in this repo), so this is the link until that changes.
 *
 * Update this by hand when a workspace starts paying. Get the ID from
 * the Stripe Dashboard → Customers → the workspace's customer → the
 * cus_... value.
 */
export const WORKSPACE_STRIPE_CUSTOMER_ID: Record<string, string> = {
  '653257d9-c0f1-4271-be6d-3e2596fd893e': 'cus_UwkDHMtSodwyCc', // Bimini Island Tours
}

export function stripeCustomerIdForWorkspace(workspaceId: string): string | null {
  return WORKSPACE_STRIPE_CUSTOMER_ID[workspaceId] ?? null
}

/**
 * Fallback monthly price, in USD, for workspaces with no Stripe customer
 * ID above (or if the live Stripe lookup fails). Same manually-maintained
 * spirit as MONITORED_CRONS in lib/cron-run-log.ts — proportionate given
 * how few paying workspaces exist today. Workspaces with no entry show
 * "—" on the Cost page, not $0.
 */
export const WORKSPACE_MONTHLY_PRICE_USD: Record<string, number> = {
  '653257d9-c0f1-4271-be6d-3e2596fd893e': 79, // Bimini Island Tours — live 2026-07-01
}

export function monthlyPriceForWorkspace(workspaceId: string): number | null {
  return WORKSPACE_MONTHLY_PRICE_USD[workspaceId] ?? null
}
