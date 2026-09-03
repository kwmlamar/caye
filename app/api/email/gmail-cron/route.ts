import { NextRequest, NextResponse } from 'next/server'
import { runGmailPoll } from '@/app/api/email/gmail-poll/route'
import {
  syncRecentGmailAttachmentEvidence,
  type GmailAttachmentSyncStats,
} from '@/lib/artifacts/gmail-attachment-sync'

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
 *
 * The two passes report independently on purpose. The poll is this cron's
 * primary responsibility and has already committed its work by the time the
 * attachment pass starts, so a failure in the newer attachment path must not
 * be reported as a Gmail polling failure: that would tell cron monitoring that
 * email ingestion is down when it actually succeeded, and would let a bug in
 * attachment evidence mask a real mail-ingestion outage. The failure is
 * surfaced in the response body rather than swallowed, so it stays observable
 * without corrupting the poll's health signal.
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

    let attachmentEvidence: GmailAttachmentSyncStats | null = null
    let attachmentEvidenceError: string | null = null
    try {
      attachmentEvidence = await syncRecentGmailAttachmentEvidence()
    } catch (err) {
      attachmentEvidenceError = err instanceof Error ? err.message : 'Unknown error'
      console.error('[gmail-cron] attachment evidence sync failed:', err)
    }

    return NextResponse.json({
      ...poll,
      attachmentEvidence,
      ...(attachmentEvidenceError ? { attachmentEvidenceError } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[gmail-cron] poll failed:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
