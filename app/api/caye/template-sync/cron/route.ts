/**
 * GET /api/caye/template-sync/cron
 *
 * Hourly cron — reconciles whatsapp_templates against the live definitions
 * on Meta (see lib/whatsapp/template-sync.ts for the full why).
 *
 * Short version: the table is what the send path trusts when deciding how
 * many params a template takes, and nothing kept it honest. A template
 * edited in WhatsApp Manager (caye_morning_digest, 3 → 4 placeholders on
 * 2026-07-21) left every subsequent send rejected with 132000 for a week.
 *
 * Cheap and idempotent — one Graph API read plus writes only for rows that
 * actually drifted.
 *
 * Authenticated via CRON_SECRET. Accepts either `x-cron-secret: <secret>`
 * or `Authorization: Bearer <secret>`. Register on cron-job.org alongside
 * the other crons.
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordCronRun } from '@/lib/cron-run-log'
import { syncWhatsAppTemplates } from '@/lib/whatsapp/template-sync'

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    return NextResponse.json(await runTemplateSync())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Extracted so both the scheduled hit above and a founder-triggered manual
 * run (lib/caye-agent/tools/admin/write-high/trigger-cron.ts, via Admin
 * Shell) go through the exact same code — same pattern as the other crons.
 */
export async function runTemplateSync() {
  return recordCronRun('template-sync', async () => syncWhatsAppTemplates())
}
