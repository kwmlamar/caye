import { NextRequest, NextResponse } from 'next/server'
import { runGmailPoll } from '@/app/api/email/gmail-poll/route'
import { syncRecentGmailAttachmentEvidence } from '@/lib/artifacts/gmail-attachment-sync'

/**
 * Vercel cron entrypoint for Gmail ingestion.
 *
 * Vercel sends CRON_SECRET as `Authorization: Bearer <secret>`, while the
 * older gmail-poll route historically only accepted x-cron-secret. Keep both
 * forms here so manual/internal callers remain compatible without weakening
 * authentication.
 *
 * Attachment evidence runs only AFTER the normal poll completes. It is a
 * bounded pass over Caye's own recently-persisted Gmail message ids, not a
 * mailbox crawl, and it never sends mail or mutates Gmail state.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided =
    req.headers.get('x-cron-secret') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (secret && provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const poll = await runGmailPoll()
    const attachments = await syncRecentGmailAttachmentEvidence()
    return NextResponse.json({ ...poll, attachmentEvidence: attachments })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[gmail-cron] poll failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
