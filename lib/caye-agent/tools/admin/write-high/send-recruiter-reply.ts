import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { draftRecruiterReply } from '@/lib/job-search/response-draft'
import { sendFounderRecruiterReply } from '@/lib/job-search/founder-mail'
import { logJobSearchEvent } from '@/lib/job-search/events'
import type { Tool } from '../../types'

type Input = { application_id: string; body?: string }

/**
 * HIGH-RISK: sends a real email to a real recruiter from the founder's own
 * mailbox. gateAdminHighRisk (see registry.ts) enforces the two-call
 * confirmation loop for this — it is deliberately NOT added to
 * STANDING_AUTHORIZED_TOOLS in admin-high-risk-gate.ts, so a standing
 * application-submission authorization never covers sending mail.
 *
 * The recipient, subject, category, and reply-threading are always
 * RE-DERIVED server-side from draftRecruiterReply — never taken from model
 * args — so this tool cannot be talked into sending to an arbitrary
 * address or past a founder-only category (offer / rejection /
 * interview_request / unknown) no matter what `body` is supplied. `body`
 * is an optional override for the founder's edited wording only.
 */
export const sendRecruiterReplyTool: Tool<Input> = {
  name: 'send_recruiter_reply',
  description:
    'Send a routine reply to a recruiter/ATS response on a job application. HIGH-RISK: this sends a real email to a real person. Confirmation is enforced in code — the first call only stages what would be sent; relay the draft (call draft_recruiter_reply first if you have not already) and call again with identical arguments once the founder confirms in a NEW message. Refuses for anything outside routine categories regardless of the body supplied.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    required: ['application_id'],
    properties: {
      application_id: { type: 'string' },
      body: { type: 'string', description: 'Optional replacement text for the drafted reply (e.g. the founder\'s edited wording). Recipient/subject/threading always come from the current draft, never from this call.' },
    },
  },

  async execute(args) {
    try {
      const drafted = await draftRecruiterReply(args.application_id)
      if (!drafted.ok) return { ok: false, error: drafted.reason }

      const body = args.body?.trim() || drafted.draft.body
      const { to, subject, category, replyToMessageId } = drafted.draft

      const { messageId } = await sendFounderRecruiterReply({
        applicationId: args.application_id, to, subject, body, replyToMessageId,
      })

      const supabase = createServiceClient()
      const now = new Date().toISOString()
      const note = `${to}: ${subject}`.slice(0, 500)

      if (category === 'scheduled_followup') {
        // Resolve the existing unsent check-in marker rather than inserting a
        // duplicate outbound row — see followup-scheduler.ts's anti-annoyance
        // cap, which counts outbound scheduled_followup rows.
        await supabase.from('job_search_followups')
          .update({ sent_at: now, body, note })
          .eq('application_id', args.application_id)
          .eq('followup_type', 'scheduled_followup')
          .eq('direction', 'outbound')
          .is('sent_at', null)
      } else {
        await supabase.from('job_search_followups').insert({
          application_id: args.application_id, followup_type: category, direction: 'outbound', channel: 'email', sent_at: now, body, note,
        })
      }

      await logJobSearchEvent({
        eventType: 'application_reply_sent',
        entityType: 'application',
        entityId: args.application_id,
        payload: { category, to, zohoMessageId: messageId },
      })

      return { ok: true, data: { application_id: args.application_id, sent_to: to, subject, category, zoho_message_id: messageId } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not send the recruiter reply' }
    }
  },
}
