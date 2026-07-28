import 'server-only'
import Stripe from 'stripe'

let client: Stripe | null = null

/** Lazy singleton — avoids constructing a Stripe client (and requiring
 *  STRIPE_SECRET_KEY) on import paths that never actually call Stripe. */
export function getStripeClient(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    client = new Stripe(key)
  }
  return client
}

export interface StripeSubscriptionSummary {
  subscription_id: string
  status: Stripe.Subscription.Status
  monthly_price_usd: number
}

/** Cents-per-billing-period → USD-per-month, for the interval shapes the
 *  configured Stripe prices actually use (month/year). Doesn't attempt to
 *  net out discounts/coupons — Bimini's plan has none (STATE.md: "no
 *  founding discount"), and this is a founder-facing estimate, not an
 *  invoice reconciliation. */
function monthlyEquivalent(price: Stripe.Price): number {
  const amount = (price.unit_amount ?? 0) / 100
  const recurring = price.recurring
  if (!recurring) return amount
  const { interval, interval_count } = recurring
  if (interval === 'year') return (amount * 12) / interval_count / 12
  if (interval === 'month') return amount / interval_count
  if (interval === 'week') return (amount * 52) / interval_count / 12
  return (amount * 365) / interval_count / 12 // day
}

/**
 * Real-time lookup, no local cache/table — proportionate to the handful
 * of paying workspaces today (2026-07-28 decision). Returns null if the
 * customer has no active/trialing subscription, or if the Stripe call
 * fails for any reason (bad ID, network) — callers should fall back to
 * the manually-maintained price in lib/workspace-pricing.ts, not fail the
 * whole page.
 */
export async function getActiveSubscriptionSummary(stripeCustomerId: string): Promise<StripeSubscriptionSummary | null> {
  const stripe = getStripeClient()
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 10,
  })

  const sub = subscriptions.data.find((s) => s.status === 'active' || s.status === 'trialing')
    ?? subscriptions.data[0]
  if (!sub) return null

  const monthly = sub.items.data.reduce((acc, item) => acc + monthlyEquivalent(item.price) * (item.quantity ?? 1), 0)

  return {
    subscription_id: sub.id,
    status: sub.status,
    monthly_price_usd: Number(monthly.toFixed(2)),
  }
}
