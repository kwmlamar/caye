/**
 * GET /api/unsubscribe/[token]
 *
 * One-click CAN-SPAM unsubscribe for cold-outreach recipients. token is
 * outreach_leads.demo_token — the same token used by the tracked "tried
 * Caye" link (app/api/r/[token]) since the two routes do different,
 * non-conflicting things with the same per-lead key: this one is a hard
 * stop the outreach-autosend-scan cron checks (opted_out_at), independent
 * of reply detection, per the original 20260721c_outreach_leads.sql design.
 *
 * No auth — the token itself is the credential, same trust model as every
 * unsubscribe link. Idempotent: hitting it twice is a no-op the second time.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('outreach_leads')
    .select('id, opted_out_at')
    .eq('demo_token', token)
    .maybeSingle()

  if (lead && !lead.opted_out_at) {
    await supabase
      .from('outreach_leads')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', lead.id)
  }

  return new NextResponse(
    '<!doctype html><html><body style="font-family: sans-serif; padding: 40px; text-align: center;">' +
    '<p>You’ve been unsubscribed. You won’t hear from us again.</p>' +
    '</body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  )
}
