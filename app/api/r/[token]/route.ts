/**
 * GET /api/r/[token]
 *
 * The tracked link embedded in every autonomous cold-outreach email's demo
 * CTA (lib/outreach-compliance.ts's buildTrackedDemoLink). token is
 * outreach_leads.demo_token.
 *
 * Stamps status='tried' + tried_at on first hit classified as plausibly
 * human (idempotent — later hits no-op) then redirects straight to the
 * WhatsApp deep link, same wa.me/<number>?text=<prefill> pattern
 * app/signup/page.tsx already uses.
 *
 * Bot filtering (2026-09-03, outreach-tried-signal-integrity): production
 * evidence showed this route was stamping tried_at on mail security
 * scanners prefetching the link on delivery, not on people — 16 leads
 * marked tried, zero real demo conversations, 9/16 stamped the same day
 * as send. classifyOutreachClick (lib/outreach-click-classifier.ts) now
 * gates the stamp. The redirect itself is NEVER gated — a misclassified
 * human must still reach WhatsApp; classification only controls whether
 * the lifecycle event is recorded. See that module for the full signal
 * list and thresholds.
 *
 * Known simplification, still true after the above fix: a human-
 * classified click measures "clicked through and opened WhatsApp with
 * Caye's number prefilled," not "actually sent the message and completed
 * the demo conversation." lib/outreach-click-demo-confirmation.ts is the
 * stronger, separate fact (demo_confirmed_at) and documents exactly what
 * a follow-up webhook-side change would need — not wired up here (out of
 * scope, see that file's module comment).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordSalesLifecycleEvent } from '@/lib/sales/lifecycle'
import { classifyOutreachClick } from '@/lib/outreach-click-classifier'

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://meetcaye.com'
}

function redirectTarget(): string {
  const cayeNumber = process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER
  if (!cayeNumber) {
    // No WhatsApp number configured — fall back to the normal signup page
    // rather than a broken wa.me link.
    return `${appUrl()}/signup`
  }
  const prefill = "Hi Caye! I'd like to try it."
  return `https://wa.me/${cayeNumber}?text=${encodeURIComponent(prefill)}`
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('outreach_leads')
    .select('id, workspace_id, tried_at, first_touch_sent_at')
    .eq('demo_token', token)
    .maybeSingle()

  if (lead && !lead.tried_at) {
    const classification = classifyOutreachClick({
      method: req.method,
      userAgent: req.headers.get('user-agent'),
      purpose: req.headers.get('purpose'),
      secPurpose: req.headers.get('sec-purpose'),
      xPurpose: req.headers.get('x-purpose'),
      xMoz: req.headers.get('x-moz'),
      secFetchMode: req.headers.get('sec-fetch-mode'),
      secFetchDest: req.headers.get('sec-fetch-dest'),
      firstTouchSentAt: lead.first_touch_sent_at,
    })

    if (classification.isLikelyHuman) {
      await recordSalesLifecycleEvent({
        workspaceId: lead.workspace_id,
        leadId: lead.id,
        event: 'demo_link_clicked',
        eventKey: `demo-click:${lead.id}`,
      })
    } else {
      // Leave a trail rather than silently dropping the signal — lets the
      // next person see how much scanner traffic is being filtered and
      // sanity-check the classifier's thresholds against real logs.
      console.info(
        `[outreach-click] rejected non-human hit for lead ${lead.id}: ${classification.reason}`
      )
    }
  }

  return NextResponse.redirect(redirectTarget())
}

/**
 * A HEAD request is never a human clicking a link — only ever a prefetch/
 * preflight probe. Next.js App Router auto-generates a HEAD handler from
 * GET (stripping the body) when no HEAD is exported, which would still run
 * GET's body and could stamp tried_at on a bare HEAD probe. Exporting HEAD
 * explicitly here overrides that and skips the DB lookup + classification
 * entirely — cheaper for bot/prefetch traffic, and there is nothing to
 * record for a request type that is rejected outright regardless.
 */
export async function HEAD() {
  return NextResponse.redirect(redirectTarget())
}
