import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { CodingSessionRow } from './queries'

const STATUS_COPY: Record<CodingSessionRow['status'], (s: CodingSessionRow) => string> = {
  pushed: (s) => `✅ Coding session pushed to main: ${s.final_commit_sha}\nTask: ${s.task}`,
  failed: (s) => `❌ Coding session failed (gate or push). Task: ${s.task}\nCheck the panel for details.`,
  timed_out: (s) => `⏱️ Coding session timed out. Task: ${s.task}`,
  killed: (s) => `🛑 Coding session killed. Task: ${s.task}`,
  booting: () => '',
  running: () => '',
  testing: () => '',
}

/**
 * Direct copy of alertFounderOfStaleCrons' shape (lib/cron-run-log.ts):
 * system/ops event -> platform_settings.founder_phone -> sendFreeFormWhatsApp
 * directly, no per-workspace caye_outbound_queue involved (that's for
 * customer-facing business events, not this).
 */
export async function notifyFounderCodingSessionDone(session: CodingSessionRow): Promise<void> {
  const copyFn = STATUS_COPY[session.status]
  const body = copyFn(session)
  if (!body) return // non-terminal status, nothing to notify

  const supabase = createServiceClient()
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'founder_phone')
    .maybeSingle()

  const founderPhone = setting?.value as string | undefined
  if (!founderPhone) {
    console.error('[coding-session] session finished but no founder_phone configured:', session.id)
    return
  }

  const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
  const result = await sendFreeFormWhatsApp(
    founderPhone,
    body,
    `coding-session-${session.id}-${session.status}`
  )
  if (result.status === 'failed') {
    console.error('[coding-session] founder notify send failed:', result.error)
  }
}
