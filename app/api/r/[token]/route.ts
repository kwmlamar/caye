/**
 * GET /api/r/[token]
 *
 * The tracked link embedded in every autonomous cold-outreach email's demo
 * CTA (lib/outreach-compliance.ts's buildTrackedDemoLink). token is
 * outreach_leads.demo_token.
 *
 * Stamps status='tried' + tried_at on first hit (idempotent — later hits
 * no-op) then redirects straight to the WhatsApp deep link, same
 * wa.me/<number>?text=<prefill> pattern app/signup/page.tsx already uses.
 *
 * Known simplification: this measures "clicked through and opened
 * WhatsApp with Caye's number prefilled," not "actually sent the message
 * and completed the demo conversation." A stronger signal would require
 * the WhatsApp inbound webhook to parse a ref token out of the prefilled
 * text and confirm the message actually arrived — not built here, out of
 * scope for this pass. Documented rather than silently overclaimed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordSalesLifecycleEvent } from '@/lib/sales/lifecycle'

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://meetcaye.com'
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('outreach_leads')
    .select('id, workspace_id, tried_at')
    .eq('demo_token', token)
    .maybeSingle()

  if (lead && !lead.tried_at) {
    await recordSalesLifecycleEvent({
      workspaceId: lead.workspace_id,
      leadId: lead.id,
      event: 'demo_link_clicked',
      eventKey: `demo-click:${lead.id}`,
    })
  }

  const cayeNumber = process.env.NEXT_PUBLIC_CAYE_WHATSAPP_NUMBER
  if (!cayeNumber) {
    // No WhatsApp number configured — fall back to the normal signup page
    // rather than a broken wa.me link.
    return NextResponse.redirect(`${appUrl()}/signup`)
  }

  const prefill = "Hi Caye! I'd like to try it."
  const waHref = `https://wa.me/${cayeNumber}?text=${encodeURIComponent(prefill)}`
  return NextResponse.redirect(waHref)
}
