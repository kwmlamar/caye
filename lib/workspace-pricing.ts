import 'server-only'

/**
 * Manually-maintained monthly price per workspace, in USD. Backs the
 * Cost page's margin column (price − LLM/WhatsApp cost).
 *
 * There is no queryable revenue source to derive this from: customers.plan
 * and stripe_* columns exist in schema but nothing populates them (no
 * Stripe webhook/sync in this repo) — Bimini's $79/mo lives only in
 * STATE.md and a Stripe Payment Link. Given exactly one paying workspace
 * today, a hardcoded map (same spirit as MONITORED_CRONS in
 * lib/cron-run-log.ts) is proportionate; move to a real customers column
 * once there's more than a couple of paying workspaces to track.
 *
 * Update this by hand when a workspace starts/stops paying or its price
 * changes. Workspaces with no entry show "—" on the Cost page, not $0.
 */
export const WORKSPACE_MONTHLY_PRICE_USD: Record<string, number> = {
  '653257d9-c0f1-4271-be6d-3e2596fd893e': 79, // Bimini Island Tours — live 2026-07-01
}

export function monthlyPriceForWorkspace(workspaceId: string): number | null {
  return WORKSPACE_MONTHLY_PRICE_USD[workspaceId] ?? null
}
