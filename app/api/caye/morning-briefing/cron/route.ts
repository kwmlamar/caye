/**
 * GET /api/caye/morning-briefing/cron
 *
 * RETIRED 2026-07-25. This used to send its own proactive "good morning"
 * WhatsApp ping per workspace, gated only by briefing_time + last-sent-today
 * — it never checked workspace_ai_config.digest_days (that setting didn't
 * exist yet when this cron was built, see 20260611_morning_briefing.sql
 * predating 20260724_digest_days.sql). Result: Bimini's Settings card said
 * Mon–Fri only, but this cron fired every day including Saturday, because
 * the digest_days gate it should have shared lives entirely in the other
 * morning cron (app/api/caye/morning-digest/route.ts + isDigestHour in
 * lib/whatsapp/schedule.ts).
 *
 * Rather than duplicate that gating here, this cron is retired in favor of
 * morning-digest as the single owner-facing morning message — same
 * consolidation shape as escalation-followup's owner-ping removal on
 * 2026-07-21 (see that route's header comment). The endpoint is kept alive
 * (not deleted) because it's still registered as an hourly hit on
 * cron-job.org and returning 404 there is noisier than a fast no-op; delete
 * the cron-job.org registration when convenient and this file can go too.
 *
 * composeMorningBriefing() in lib/caye-agent/briefing.ts is now unused by
 * any cron — left in place in case its richer LLM-composed narrative style
 * gets folded into morning-digest's content later (separate decision from
 * this scheduling fix).
 */

import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  // Accept either Authorization: Bearer <secret> or x-cron-secret: <secret>
  // — matches outbound-worker so all cron-job.org jobs share one header shape.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  return NextResponse.json({ status: 'retired', detail: 'folded into morning-digest, see file header' })
}
